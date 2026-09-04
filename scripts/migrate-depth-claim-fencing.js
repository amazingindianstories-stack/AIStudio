/**
 * Add the durable depth-worker fencing lease. Every statement is additive
 * and idempotent so an interrupted operator run is safe to repeat.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { sql } from "drizzle-orm";
import { getDb } from "../src/lib/db";

const statements = [
  `alter table generations add column if not exists depth_claim_id uuid`,
  `alter table generations add column if not exists depth_claim_worker_id text`,
  `alter table generations add column if not exists depth_reap_attempts integer not null default 0`,
  `alter table depth_workers add column if not exists current_claim_id uuid`,
  `alter table depth_workers add column if not exists protocol_version integer not null default 1`,
];

async function main() {
  const db = await getDb();
  for (const statement of statements) await db.execute(sql.raw(statement));
  const verification = await db.execute(sql`
    select count(*)::int as columns
    from information_schema.columns
    where table_schema = current_schema()
      and (
        (table_name = 'generations' and column_name in (
          'depth_claim_id', 'depth_claim_worker_id', 'depth_reap_attempts'
        ))
        or
        (table_name = 'depth_workers' and column_name in (
          'current_claim_id', 'protocol_version'
        ))
      )
  `);
  const row = (verification.rows ?? verification)[0];
  if (Number(row?.columns) !== 5) {
    throw new Error("Depth claim-fencing migration verification failed.");
  }
  console.log("Depth claim-fencing columns verified.");
}

main().then(() => process.exit(0), (error) => {
  console.error(error?.message || error);
  process.exit(1);
});
