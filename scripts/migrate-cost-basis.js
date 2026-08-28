import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { getDb } from "../src/lib/db.js";

config({ path: process.env.ENV_FILE || ".env.local" });

// Additive and idempotent so it can be applied before the application deploy.
// Existing rows intentionally remain estimates: their historical provider
// response is unavailable, so a backfill by model name would invent precision.
async function main() {
  const db = await getDb();
  await db.execute(sql.raw(
    "alter table generations add column if not exists cost_basis text not null default 'estimated'"
  ));
  console.log("generations.cost_basis is ready");
  process.exit(0);
}

main().catch((error) => {
  console.error("Cost-basis migration failed:", error);
  process.exit(1);
});
