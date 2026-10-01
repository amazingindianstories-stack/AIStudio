import { config } from "dotenv";
import { getTableColumns, getTableName, sql } from "drizzle-orm";
import { getDb } from "../src/lib/db.js";
import * as schema from "../src/lib/schema.js";

config({ path: process.env.ENV_FILE || ".env.local" });

// Read-only release gate. This deliberately compares the live database with
// every Drizzle-owned table instead of maintaining another hand-written list
// that can drift at the same time as a migration.
async function main() {
  const db = await getDb();
  const missing = [];

  for (const [exportName, table] of Object.entries(schema)) {
    const columns = Object.values(getTableColumns(table));
    if (!columns.length) continue;

    const tableName = getTableName(table);
    const result = await db.execute(sql`
      select column_name
      from information_schema.columns
      where table_schema = current_schema() and table_name = ${tableName}
    `);
    const liveColumns = new Set((result.rows ?? result).map((row) => row.column_name));

    if (liveColumns.size === 0) {
      missing.push(`${exportName} (${tableName}): table is missing`);
      continue;
    }
    for (const column of columns) {
      if (!liveColumns.has(column.name)) {
        missing.push(`${exportName} (${tableName}): column ${column.name} is missing`);
      }
    }
  }

  if (missing.length) {
    throw new Error(
      `Production schema is behind the application schema:\n- ${missing.join("\n- ")}`
    );
  }

  console.log("production schema matches all Drizzle-owned tables");
  process.exit(0);
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
