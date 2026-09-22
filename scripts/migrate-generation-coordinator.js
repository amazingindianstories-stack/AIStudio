import { getDb } from "../src/lib/db.js";
import { sql } from "drizzle-orm";
import { config } from "dotenv";

config({ path: process.env.ENV_FILE || ".env.local" });

const INDEX_NAME = "generations_coordinator_due_idx";
const REPLACEMENT_NAME = "generations_coordinator_due_replacement_idx";
const INDEX_PREDICATE = "(kind = 'video' and status in ('queued', 'running')) or (kind = 'image' and status = 'queued')";

async function getIndex(db, name) {
  const result = await db.execute(sql`
    select i.indisvalid as valid, pg_get_expr(i.indpred, i.indrelid) as predicate
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = current_schema() and c.relname = ${name}
  `);
  return (result.rows ?? result)[0];
}

function hasDesiredPredicate(index) {
  const predicate = index?.predicate ?? "";
  return index?.valid === true &&
    predicate.includes("kind = 'video'") &&
    predicate.includes("kind = 'image'") &&
    predicate.includes("status = 'queued'");
}

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
  ]) await db.execute(sql.raw(statement));

  const existing = await getIndex(db, INDEX_NAME);
  if (!hasDesiredPredicate(existing)) {
    const replacement = await getIndex(db, REPLACEMENT_NAME);
    if (replacement && !hasDesiredPredicate(replacement)) {
      await db.execute(sql.raw(`drop index concurrently if exists ${REPLACEMENT_NAME}`));
    }
    await db.execute(sql.raw(
      `create index concurrently if not exists ${REPLACEMENT_NAME} on generations (status, next_poll_at, created_at) where ${INDEX_PREDICATE}`
    ));
    if (!hasDesiredPredicate(await getIndex(db, REPLACEMENT_NAME))) {
      throw new Error("Coordinator replacement index was not valid.");
    }
    await db.execute(sql.raw(`drop index concurrently if exists ${INDEX_NAME}`));
    await db.execute(sql.raw(`alter index ${REPLACEMENT_NAME} rename to ${INDEX_NAME}`));
  }
  if (!hasDesiredPredicate(await getIndex(db, INDEX_NAME))) {
    throw new Error("Coordinator index verification failed.");
  }
  console.log("generation coordinator migration and index verified");
}

main().catch((error) => {
  console.error("generation coordinator migration failed:", error);
  process.exitCode = 1;
});
