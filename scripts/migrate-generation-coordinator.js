import { getDb } from "../src/lib/db.js";
import { sql } from "drizzle-orm";
import { config } from "dotenv";

config({ path: process.env.ENV_FILE || ".env.local" });

// Online/idempotent migration for the server-owned generation coordinator.
// `drizzle-kit push` remains the normal schema workflow; this script is safe
// to run during rollout against an existing production table.
async function main() {
  const db = await getDb();
  for (const statement of [
  `alter table generations add column if not exists provider_responses jsonb`,
  `alter table generations add column if not exists submitted_at bigint`,
  `alter table generations add column if not exists provider_created_at bigint`,
  `alter table generations add column if not exists provider_updated_at bigint`,
  `alter table generations add column if not exists completed_at bigint`,
  `alter table generations add column if not exists last_poll_at bigint`,
  `alter table generations add column if not exists next_poll_at bigint`,
  `alter table generations add column if not exists poll_attempts integer not null default 0`,
  `alter table generations add column if not exists callback_received_at bigint`,
  `alter table generations add column if not exists provider_status text`,
  `alter table generations add column if not exists worker_lease_id text`,
  `alter table generations add column if not exists worker_lease_until bigint`,
  `create index concurrently if not exists generations_coordinator_due_idx on generations (status, next_poll_at, created_at) where kind in ('video', 'image') and status in ('queued', 'running')`,
  ]) await db.execute(sql.raw(statement));
  console.log("generation coordinator migration complete");
}

main().catch((error) => {
  console.error("generation coordinator migration failed:", error);
  process.exitCode = 1;
});
