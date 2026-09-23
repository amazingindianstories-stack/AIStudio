import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { getDb } from "../src/lib/db.js";

config({ path: process.env.ENV_FILE || ".env.local" });

async function main() {
  const db = await getDb();
  await db.execute(sql.raw("alter table generations add column if not exists source_generation_id uuid"));
  await db.execute(sql.raw("alter table generations add column if not exists draft_task_id text"));
  console.log("Seedance draft-final lineage columns are ready");
  process.exit(0);
}

main().catch((error) => {
  console.error("Seedance finalization migration failed:", error);
  process.exit(1);
});
