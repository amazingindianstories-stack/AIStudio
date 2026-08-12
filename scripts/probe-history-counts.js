/**
 * Read-only probe: do the folder-rail counts now report real numbers?
 *
 * This is the check for the reported bug where every folder in an older
 * project displayed "0" — the counts were computed from whatever slice of
 * global history the client had paged in, so a project whose items sat below
 * that window counted nothing. Only SELECTs.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { getDb } from "../src/lib/db";
import { projects, folders } from "../src/lib/schema";
import { countHistory, countScope, queryHistory } from "../src/lib/store-db";

async function main() {
  const db = await getDb();
  const allProjects = await db.select().from(projects);
  const allFolders = await db.select().from(folders);

  console.log(`${allProjects.length} projects, ${allFolders.length} folders\n`);

  for (const p of allProjects) {
    const counts = await countHistory({ projectId: p.id });
    const mine = allFolders.filter((f) => f.projectId === p.id);
    const named = mine
      .map((f) => `${f.name}=${counts.byFolder[f.id] ?? 0}`)
      .join(", ");
    console.log(
      `${p.name}\n  total=${counts.total} unsorted=${counts.unsorted}` +
        (mine.length ? `\n  folders: ${named}` : "\n  (no folders)")
    );

    // Cross-check: the grouped count must equal what paging the scope yields.
    const images = await countScope({ projectId: p.id, kind: "image" });
    const videos = await countScope({ projectId: p.id, kind: "video" });
    const agrees = images + videos === counts.total;
    console.log(`  images=${images} videos=${videos} sums to total? ${agrees}`);

    // And the first page must actually be non-empty when the count is.
    if (counts.total > 0) {
      const page = await queryHistory({ projectId: p.id }, undefined, 3);
      console.log(
        `  first page returns ${page.items.length} rows (count says ${counts.total})`
      );
    }
    console.log();
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("PROBE FAILED:", e);
    process.exit(1);
  }
);
