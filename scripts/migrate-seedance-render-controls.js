import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { getDb } from "../src/lib/db.js";

config({ path: process.env.ENV_FILE || ".env.local" });

// Additive and idempotent. Run before deploying application code that writes
// these fields. Existing rows intentionally stay null so the UI can identify
// them as legacy generations whose render settings were never recorded.
async function main() {
  const db = await getDb();
  await db.execute(sql.raw(
    "alter table generations add column if not exists draft_mode boolean"
  ));
  await db.execute(sql.raw(
    "alter table generations add column if not exists bitrate_mode text"
  ));
  console.log("generations draft_mode and bitrate_mode are ready");
  process.exit(0);
}

main().catch((error) => {
  console.error("Seedance render-controls migration failed:", error);
  process.exit(1);
});
