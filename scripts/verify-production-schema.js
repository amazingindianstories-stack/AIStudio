import { config } from "dotenv";
import { getTableColumns, getTableName, sql } from "drizzle-orm";
import { getDb } from "../src/lib/db.js";
import * as schema from "../src/lib/schema.js";

config({ path: process.env.ENV_FILE || ".env.local" });

// Read-only release gate. This deliberately compares the live database with
// every Drizzle-owned table instead of maintaining another hand-written list
// that can drift at the same time as a migration.
export async function verifyProductionSchema(customDb = null) {
  const db = customDb || (await getDb());
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

  const expectedNamingIndexes = [
    "generation_naming_namespace_seq_idx",
    "generation_naming_namespace_idx",
  ];
  const namingIndexResult = await db.execute(sql`
    select indexname
    from pg_indexes
    where schemaname = current_schema() and tablename = 'generation_naming'
  `);
  const liveNamingIndexes = new Set((namingIndexResult.rows ?? namingIndexResult).map((r) => r.indexname));
  const missingNamingIndexes = expectedNamingIndexes.filter((idx) => !liveNamingIndexes.has(idx));
  if (missingNamingIndexes.length > 0) {
    throw new Error(
      `Production schema is missing generation naming indexes:\n- ${missingNamingIndexes.join("\n- ")}`
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

  // Verify foreign key constraints
  const expectedForeignKeys = [
    "folders_project_id_fkey",
    "folders_parent_id_fkey",
    "generations_project_id_fkey",
    "generations_folder_id_fkey",
    "generation_naming_generation_id_fkey",
  ];
  const fkResult = await db.execute(sql`
    select conname
    from pg_constraint
    where contype = 'f'
      and conname in ('folders_project_id_fkey', 'folders_parent_id_fkey', 'generations_project_id_fkey', 'generations_folder_id_fkey', 'generation_naming_generation_id_fkey');
  `);
  const liveFks = new Set((fkResult.rows ?? fkResult).map((r) => r.conname));
  const missingFks = expectedForeignKeys.filter((fk) => !liveFks.has(fk));
  if (missingFks.length > 0) {
    throw new Error(
      `Production schema is missing required foreign keys:\n- ${missingFks.join("\n- ")}`
    );
  }

  // Verify check constraints
  const expectedCheckConstraints = [
    "generation_naming_sequence_check",
  ];
  const checkResult = await db.execute(sql`
    select conname
    from pg_constraint
    where contype = 'c'
      and conname in ('generation_naming_sequence_check');
  `);
  const liveChecks = new Set((checkResult.rows ?? checkResult).map((r) => r.conname));
  const missingChecks = expectedCheckConstraints.filter((c) => !liveChecks.has(c));
  if (missingChecks.length > 0) {
    throw new Error(
      `Production schema is missing required check constraints:\n- ${missingChecks.join("\n- ")}`
    );
  }

  // Verify triggers
  const expectedTriggers = [
    "trg_sync_folder_name_normalized",
    "trg_check_folder_scope",
    "trg_check_generation_scope",
    "trg_check_generation_naming_scope",
    "trg_check_generation_location_naming",
  ];
  const trgResult = await db.execute(sql`
    select trigger_name
    from information_schema.triggers
    where trigger_schema = current_schema()
      and trigger_name in (
        'trg_sync_folder_name_normalized',
        'trg_check_folder_scope',
        'trg_check_generation_scope',
        'trg_check_generation_naming_scope',
        'trg_check_generation_location_naming'
      );
  `);
  const liveTrgs = new Set((trgResult.rows ?? trgResult).map((r) => r.trigger_name));
  const missingTrgs = expectedTriggers.filter((trg) => !liveTrgs.has(trg));
  if (missingTrgs.length > 0) {
    throw new Error(
      `Production schema is missing required triggers:\n- ${missingTrgs.join("\n- ")}`
    );
  }

  // Live invariant checks
  const orphanFolderRes = await db.execute(sql`
    SELECT count(*)::int as count
    FROM generations g
    LEFT JOIN folders f ON g.folder_id = f.id
    WHERE g.folder_id IS NOT NULL AND f.id IS NULL;
  `);
  const orphanFolderCount = (orphanFolderRes.rows ?? orphanFolderRes)[0]?.count;
  if (Number(orphanFolderCount || 0) > 0) {
    throw new Error(`Data invariant violation: found ${orphanFolderCount} generations referencing nonexistent folders.`);
  }

  const folderScopeMismatchRes = await db.execute(sql`
    SELECT count(*)::int as count
    FROM folders c
    JOIN folders p ON c.parent_id = p.id
    WHERE (c.project_id IS DISTINCT FROM p.project_id);
  `);
  const folderScopeMismatch = (folderScopeMismatchRes.rows ?? folderScopeMismatchRes)[0]?.count;
  if (Number(folderScopeMismatch || 0) > 0) {
    throw new Error(`Data invariant violation: found ${folderScopeMismatch} child folders with mismatched project_id from their parent.`);
  }

  const genScopeMismatchRes = await db.execute(sql`
    SELECT count(*)::int as count
    FROM generations g
    JOIN folders f ON g.folder_id = f.id
    WHERE (g.project_id IS DISTINCT FROM f.project_id);
  `);
  const genScopeMismatch = (genScopeMismatchRes.rows ?? genScopeMismatchRes)[0]?.count;
  if (Number(genScopeMismatch || 0) > 0) {
    throw new Error(`Data invariant violation: found ${genScopeMismatch} generations with mismatched project_id from their folder.`);
  }

  // Live naming invariant checks
  const unassignedNamingRes = await db.execute(sql`
    SELECT count(*)::int as count
    FROM generations g
    LEFT JOIN generation_naming gn ON g.id = gn.generation_id
    WHERE gn.generation_id IS NULL;
  `);
  const unassignedNamingCount = (unassignedNamingRes.rows ?? unassignedNamingRes)[0]?.count;
  if (Number(unassignedNamingCount || 0) > 0) {
    throw new Error(`Data invariant violation: found ${unassignedNamingCount} generations missing naming assignments.`);
  }

  const duplicateNamingRes = await db.execute(sql`
    SELECT count(*)::int as count
    FROM (
      SELECT namespace, sequence
      FROM generation_naming
      GROUP BY namespace, sequence
      HAVING count(*) > 1
    ) sub;
  `);
  const duplicateNamingCount = (duplicateNamingRes.rows ?? duplicateNamingRes)[0]?.count;
  if (Number(duplicateNamingCount || 0) > 0) {
    throw new Error(`Data invariant violation: found duplicate sequence assignments in generation_naming.`);
  }

  const counterLagRes = await db.execute(sql`
    SELECT count(*)::int as count
    FROM (
      SELECT gn.namespace
      FROM generation_naming gn
      JOIN naming_counters nc ON gn.namespace = nc.namespace
      GROUP BY gn.namespace, nc.next_sequence
      HAVING nc.next_sequence <= MAX(gn.sequence)
    ) sub;
  `);
  const counterLagCount = (counterLagRes.rows ?? counterLagRes)[0]?.count;
  if (Number(counterLagCount || 0) > 0) {
    throw new Error(`Data invariant violation: found ${counterLagCount} naming counters lagging behind max assigned sequence.`);
  }

  const namingScopeMismatchRes = await db.execute(sql`
    SELECT count(*)::int as count
    FROM generations g
    JOIN generation_naming gn ON g.id = gn.generation_id
    WHERE gn.namespace IS DISTINCT FROM (
      CASE
        WHEN g.folder_id IS NOT NULL THEN 'folder:' || g.folder_id::text
        WHEN g.project_id IS NOT NULL THEN 'project_unsorted:' || g.project_id::text
        ELSE 'global_unsorted'
      END
    );
  `);
  const namingScopeMismatch = (namingScopeMismatchRes.rows ?? namingScopeMismatchRes)[0]?.count;
  if (Number(namingScopeMismatch || 0) > 0) {
    throw new Error(`Data invariant violation: found ${namingScopeMismatch} generations whose naming namespace does not match location.`);
  }

  console.log("production schema matches all Drizzle-owned tables, foreign keys, triggers, and live invariants");
  return true;
}

if (process.argv[1] && process.argv[1].endsWith("verify-production-schema.js")) {
  verifyProductionSchema()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error?.message || error);
      process.exit(1);
    });
}
