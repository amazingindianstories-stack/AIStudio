import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { getDb } from "../src/lib/db.js";

config({ path: process.env.ENV_FILE || ".env.local" });

// Additive and idempotent. Run before deploying application code that writes
// these fields. Existing rows intentionally stay null so the UI can identify
// them as legacy generations without a last frame.
async function main() {
  const db = await getDb();
  await db.execute(sql.raw(
    "alter table generations add column if not exists last_frame_url text"
  ));
  console.log("generations last_frame_url is ready");
  process.exit(0);
}

main().catch((error) => {
  console.error("Seedance first-last-frame migration failed:", error);
  process.exit(1);
});
