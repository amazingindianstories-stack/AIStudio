/**
 * Add durable video poll-health metadata and its online reconciliation index.
 * Every statement is additive and idempotent. CREATE INDEX CONCURRENTLY is
 * intentionally issued outside a transaction so production writes continue.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { sql } from "drizzle-orm";
import { getDb } from "../src/lib/db";

const statements = [
  `alter table generations add column if not exists poll_error_count integer not null default 0`,
  `alter table generations add column if not exists last_poll_error_at bigint`,
  `create index concurrently if not exists generations_stale_video_poll_idx
     on generations (updated_at asc, created_at asc, id asc)
     where kind = 'video' and status in ('queued', 'running') and task_id is not null`,
];

async function main() {
  const db = await getDb();
  for (const statement of statements) await db.execute(sql.raw(statement));
  const verification = await db.execute(sql`
    select
      count(*) filter (where column_name in ('poll_error_count', 'last_poll_error_at'))::int as columns,
      (select count(*)::int from pg_indexes
        where schemaname = current_schema()
          and tablename = 'generations'
          and indexname = 'generations_stale_video_poll_idx') as indexes
    from information_schema.columns
    where table_schema = current_schema() and table_name = 'generations'
  `);
  const row = (verification.rows ?? verification)[0];
  if (Number(row?.columns) !== 2 || Number(row?.indexes) !== 1) {
    throw new Error("Video poll-health migration verification failed.");
  }
  console.log("Video poll-health columns and reconciliation index verified.");
}

main().then(() => process.exit(0), (error) => {
  console.error(error?.message || error);
  process.exit(1);
});
