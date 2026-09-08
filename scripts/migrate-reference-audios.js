import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { getDb } from "../src/lib/db.js";

config({ path: process.env.ENV_FILE || ".env.local" });

async function main() {
  const db = await getDb();
  await db.execute(sql.raw("alter table generations add column if not exists reference_audios jsonb"));
  const result = await db.execute(sql`select count(*)::int as columns from information_schema.columns where table_schema = current_schema() and table_name = 'generations' and column_name = 'reference_audios'`);
  const row = (result.rows ?? result)[0];
  if (Number(row?.columns) !== 1) throw new Error("reference_audios column verification failed");
  console.log("reference_audios column is present");
  process.exit(0);
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
