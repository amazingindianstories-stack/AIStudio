/**
 * Read-only probe: does the new keyset SQL actually execute and paginate
 * correctly against the live schema? Only SELECTs.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import {
  queryHistory,
  countHistory,
  countScope,
  decodeCursor,
} from "../src/lib/store-db";

async function main() {
  // 1. Unfiltered first page.
  const p1 = await queryHistory({}, undefined, 5);
  console.log(`page1: ${p1.items.length} rows, nextCursor=${p1.nextCursor}`);

  // 2. Walk several pages and check for duplicates / skips.
  const seen = new Set<string>();
  let cursor = undefined as ReturnType<typeof decodeCursor>;
  let page = 0;
  let dupes = 0;
  const ordered: number[] = [];
  do {
    const r = await queryHistory({}, cursor, 5);
    for (const it of r.items) {
      if (seen.has(it.id)) dupes++;
      seen.add(it.id);
      ordered.push(it.createdAt);
    }
    cursor = r.nextCursor ? decodeCursor(r.nextCursor) : undefined;
    page++;
  } while (cursor && page < 6);
  console.log(`walked ${page} pages, ${seen.size} unique rows, ${dupes} duplicates`);

  const monotonic = ordered.every((v, i) => i === 0 || ordered[i - 1] >= v);
  console.log(`createdAt monotonically non-increasing across pages: ${monotonic}`);

  // 3. Kind filter.
  const imgs = await queryHistory({ kind: "image" }, undefined, 5);
  console.log(
    `kind=image: ${imgs.items.length} rows, all image? ${imgs.items.every((i) => i.kind === "image")}`
  );

  // 4. Favourites (the favorited_at ordering path).
  const favs = await queryHistory({ favorite: true }, undefined, 5);
  console.log(
    `favourites: ${favs.items.length} rows, all starred? ${favs.items.every((i) => i.isFavorite)}`
  );
  if (favs.nextCursor) {
    const favs2 = await queryHistory({ favorite: true }, decodeCursor(favs.nextCursor), 5);
    console.log(`favourites page2: ${favs2.items.length} rows`);
  }

  // 5. Search with LIKE metacharacters — must be treated as literals.
  const esc = await queryHistory({ q: "100%_test" }, undefined, 3);
  console.log(`escaped-search returned ${esc.items.length} rows (no error = escaping works)`);

  // 6. Project scope + folder counts.
  const anyProject = p1.items.find((i) => i.projectId)?.projectId;
  if (anyProject) {
    const scoped = await queryHistory({ projectId: anyProject }, undefined, 5);
    console.log(
      `project ${anyProject}: ${scoped.items.length} rows, all in project? ` +
        `${scoped.items.every((i) => i.projectId === anyProject)}`
    );
    const counts = await countHistory({ projectId: anyProject });
    console.log(
      `counts: total=${counts.total} unsorted=${counts.unsorted} folders=${JSON.stringify(counts.byFolder)}`
    );
    const unsorted = await queryHistory({ projectId: anyProject, folderId: null }, undefined, 5);
    console.log(
      `unsorted page: ${unsorted.items.length} rows, all folderless? ${unsorted.items.every((i) => !i.folderId)}`
    );
  } else {
    console.log("no project-assigned rows found to scope-test");
  }

  console.log(`countScope(all)=${await countScope({})}`);
  console.log(`countScope(favourite)=${await countScope({ favorite: true })}`);

  // 7. EXPLAIN: confirm the ordering is index-backed, not a sort.
  const { getDb } = await import(
    "../src/lib/db"
  );
  const { sql } = await import("drizzle-orm");
  const db = await getDb();
  const plan: any = await db.execute(
    sql`explain select * from generations order by created_at desc, id desc limit 21`
  );
  const rows = (plan?.rows ?? plan ?? []) as any[];
  console.log("\nplan for the global feed page:");
  for (const r of rows) console.log("  " + (r["QUERY PLAN"] ?? JSON.stringify(r)));
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("PROBE FAILED:", e);
    process.exit(1);
  }
);
