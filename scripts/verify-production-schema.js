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

  // Hierarchy-critical invariants and index verification (Phase 6.4)
  const expectedIndexes = [
    "folders_project_id_idx",
    "folders_parent_id_idx",
    "folders_global_root_unique_idx",
    "folders_project_root_unique_idx",
    "folders_subfolder_unique_idx",
  ];

  const indexResult = await db.execute(sql`
    select indexname
    from pg_indexes
    where schemaname = current_schema() and tablename = 'folders'
  `);
  const liveIndexes = new Set((indexResult.rows ?? indexResult).map((r) => r.indexname));

  const missingIndexes = expectedIndexes.filter((idx) => !liveIndexes.has(idx));
  if (missingIndexes.length > 0) {
    throw new Error(
      `Production schema is missing hierarchy-critical indexes:\n- ${missingIndexes.join("\n- ")}`
    );
  }

  // Verify folders.project_id is nullable (to permit global folders)
  const projColNullability = await db.execute(sql`
    select is_nullable
    from information_schema.columns
    where table_schema = current_schema()
      and table_name = 'folders'
      and column_name = 'project_id'
  `);
  const isNullable = (projColNullability.rows ?? projColNullability)[0]?.is_nullable;
  if (isNullable !== "YES") {
    throw new Error("folders.project_id must be nullable to support global library folders.");
  }

  console.log("production schema matches all Drizzle-owned tables and hierarchy invariants");
  process.exit(0);
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
