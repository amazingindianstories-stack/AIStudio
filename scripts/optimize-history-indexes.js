/**
 * Bring an existing `generations` table up to the indexes queryHistory needs.
 *
 * Why this exists rather than `npm run db:push`: push issues a plain
 * CREATE INDEX, which takes an ACCESS EXCLUSIVE lock and blocks every write to
 * the table for the duration. On a populated production table that is a
 * user-visible outage in the middle of a generation run. CREATE INDEX
 * CONCURRENTLY does the same work without blocking writes; it just cannot run
 * inside a transaction, which is why each statement is fired on its own.
 *
 * Safe to re-run: every statement is IF NOT EXISTS, and the backfill is a
 * no-op once applied.
 *
 *   npx tsx scripts/optimize-history-indexes.ts
 *
 * Note the failure mode of CONCURRENTLY: if it is interrupted it leaves an
 * INVALID index behind, which Postgres will not use and which blocks a retry
 * of the same name. The script reports any it finds so they can be dropped.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { getDb } from "../src/lib/db";
import { sql } from "drizzle-orm";

const STATEMENTS = [
  {
    // Favourites page on (favorited_at, id). A favourited row with a NULL
    // favorited_at would sit outside that row comparison and could never be
    // paged past, so give the legacy rows the only sensible value they have.
    label: "backfill favorited_at for legacy favourites",
    sql: `update generations
             set favorited_at = created_at
           where is_favorite and favorited_at is null`,
  },
  {
    label: "generations_created_keyset_idx (All assets feed)",
    sql: `create index concurrently if not exists generations_created_keyset_idx
            on generations (created_at desc, id desc)`,
  },
  {
    label: "generations_project_keyset_idx (project feed)",
    sql: `create index concurrently if not exists generations_project_keyset_idx
            on generations (project_id, created_at desc, id desc)`,
  },
  {
    label: "generations_folder_keyset_idx (folder feed)",
    sql: `create index concurrently if not exists generations_folder_keyset_idx
            on generations (folder_id, created_at desc, id desc)`,
  },
  {
    label: "generations_favorite_keyset_idx (Favourites feed)",
    sql: `create index concurrently if not exists generations_favorite_keyset_idx
            on generations (favorited_at desc, id desc)
          where is_favorite`,
  },
];

async function main() {
  const db = await getDb();

  for (const stmt of STATEMENTS) {
    const started = Date.now();
    process.stdout.write(`→ ${stmt.label} … `);
    try {
      await db.execute(sql.raw(stmt.sql));
      console.log(`ok (${Date.now() - started}ms)`);
    } catch (err) {
      console.log("FAILED");
      console.error(`  ${err?.message ?? err}`);
      process.exitCode = 1;
    }
  }

  // An interrupted CONCURRENTLY build leaves an unusable index behind that
  // also squats on the name, so surface them rather than letting the next run
  // fail confusingly on "already exists".
  const invalid = await db.execute(sql`
    select i.relname as name
      from pg_index x
      join pg_class i on i.oid = x.indexrelid
      join pg_class t on t.oid = x.indrelid
     where t.relname = 'generations' and not x.indisvalid
  `);
  const rows = (invalid?.rows ?? invalid ?? []) ;
  if (rows.length) {
    console.warn(
      `\n! ${rows.length} invalid index(es) from an interrupted build — drop and re-run:`
    );
    for (const r of rows) console.warn(`    drop index concurrently ${r.name};`);
  }

  // Fresh indexes have no statistics of their own until the table is analysed,
  // and the planner will not consider what it cannot cost.
  console.log("\n→ analyze generations … ");
  await db.execute(sql.raw("analyze generations"));

  console.log("\nDone. Inspect a plan with:");
  console.log(
    "  explain analyze select * from generations where project_id = '<id>' " +
      "order by created_at desc, id desc limit 21;"
  );
  console.log(
    "\nNote: the planner uses these selectively and that is correct. A project\n" +
      "holding a small fraction of the table gets a pure index scan; one holding\n" +
      "~40% keeps the narrower created_at index plus a near-free incremental sort\n" +
      "(created_at is close to unique, so its presorted groups hold ~1 row).\n" +
      "Pagination correctness comes from the row-value predicate, not the index."
  );
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
