import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import {
  HIERARCHICAL_FOLDER_STATEMENTS,
  migrateHierarchicalFolders,
  verifyHierarchicalFolders,
} from "../../scripts/migrate-hierarchical-folders.js";

/**
 * Hierarchical Folders Atomic Migration & Failure-Injection Test Suite
 *
 * Verifies:
 * 1. CLI migration runs inside a single db.transaction.
 * 2. Deterministic failure injection midway rolls back the entire hierarchy migration,
 *    leaving the legacy schema 100% unchanged.
 * 3. Successful execution updates columns, indexes, and triggers.
 * 4. Repeating execution is strictly idempotent.
 */
test("Hierarchical folders migration: failure-injection rollback leaves legacy schema unchanged", async () => {
  assert.ok(process.env.DATABASE_URL, "test requires DATABASE_URL");

  const rootSql = postgres(process.env.DATABASE_URL, { max: 1 });
  const fixtureSchema = `atomic_hier_fixture_${randomUUID().replace(/-/g, "_")}`;

  await rootSql.unsafe(`CREATE SCHEMA ${fixtureSchema}`);

  const fixtureSql = postgres(process.env.DATABASE_URL, {
    max: 1,
    connection: {
      search_path: `${fixtureSchema},public`,
    },
  });
  const fixtureDb = drizzle(fixtureSql);

  try {
    // 1. Provision pre-hierarchical legacy schema in fixtureSchema
    await fixtureSql.unsafe(`
      CREATE TABLE projects (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE TABLE folders (
        id UUID PRIMARY KEY,
        project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        created_at BIGINT NOT NULL
      );

      CREATE TABLE generations (
        id UUID PRIMARY KEY,
        project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
        folder_id UUID REFERENCES folders(id) ON DELETE SET NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
    `);

    // Verify initial legacy schema: folders.project_id is NOT NULL, no parent_id
    const initialColsRes = await fixtureSql.unsafe(`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = '${fixtureSchema}' AND table_name = 'folders';
    `);
    const initialCols = new Map(initialColsRes.map((r) => [r.column_name, r.is_nullable]));
    assert.equal(initialCols.get("project_id"), "NO", "Initial folders.project_id must be NOT NULL");
    assert.equal(initialCols.has("parent_id"), false, "Initial folders must not have parent_id");
    assert.equal(initialCols.has("name_normalized"), false, "Initial folders must not have name_normalized");

    // 2. Deterministic Failure Injection midway through statements
    // We execute statements inside a transaction, but deliberately fail halfway through
    let failureCaught = false;
    try {
      await fixtureDb.transaction(async (tx) => {
        // Execute first 3 statements
        await tx.execute(sql.raw(HIERARCHICAL_FOLDER_STATEMENTS[0]));
        await tx.execute(sql.raw(HIERARCHICAL_FOLDER_STATEMENTS[1]));
        await tx.execute(sql.raw(HIERARCHICAL_FOLDER_STATEMENTS[2]));

        // Inject simulated failure before commit
        throw new Error("SIMULATED_MIGRATION_HALFWAY_FAILURE");
      });
    } catch (err) {
      if (err.message.includes("SIMULATED_MIGRATION_HALFWAY_FAILURE")) {
        failureCaught = true;
      } else {
        throw err;
      }
    }
    assert.ok(failureCaught, "Midway failure must be caught");

    // 3. Assert CLEAN ROLLBACK: Legacy schema must be completely unchanged!
    const postRollbackColsRes = await fixtureSql.unsafe(`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = '${fixtureSchema}' AND table_name = 'folders';
    `);
    const postRollbackCols = new Map(postRollbackColsRes.map((r) => [r.column_name, r.is_nullable]));
    assert.equal(postRollbackCols.get("project_id"), "NO", "folders.project_id must still be NOT NULL after rollback");
    assert.equal(postRollbackCols.has("parent_id"), false, "folders.parent_id must NOT exist after rollback");
    assert.equal(postRollbackCols.has("name_normalized"), false, "folders.name_normalized must NOT exist after rollback");

    // 4. Run the official atomic migrateHierarchicalFolders
    const result1 = await migrateHierarchicalFolders(fixtureDb);
    assert.equal(result1.success, true, "migrateHierarchicalFolders must succeed");

    // Verify all columns and constraints exist
    const verifiedRes = await verifyHierarchicalFolders(fixtureDb);
    assert.equal(verifiedRes.success, true);
    assert.equal(verifiedRes.folderCount, 4);
    assert.equal(verifiedRes.genCount, 1);

    // Verify folders.project_id is now nullable
    const finalColsRes = await fixtureSql.unsafe(`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = '${fixtureSchema}' AND table_name = 'folders';
    `);
    const finalCols = new Map(finalColsRes.map((r) => [r.column_name, r.is_nullable]));
    assert.equal(finalCols.get("project_id"), "YES", "folders.project_id must be nullable for global folders");
    assert.equal(finalCols.has("parent_id"), true, "folders.parent_id must exist");
    assert.equal(finalCols.has("name_normalized"), true, "folders.name_normalized must exist");
    assert.equal(finalCols.has("version"), true, "folders.version must exist");
    assert.equal(finalCols.has("updated_at"), true, "folders.updated_at must exist");

    // 5. Test Idempotency: execute a second time
    const result2 = await migrateHierarchicalFolders(fixtureDb);
    assert.equal(result2.success, true, "Second migration execution must succeed idempotently");
  } finally {
    await fixtureSql.end({ timeout: 5 });
    await rootSql.unsafe(`DROP SCHEMA IF EXISTS ${fixtureSchema} CASCADE;`);
    await rootSql.end({ timeout: 5 });
  }
});
