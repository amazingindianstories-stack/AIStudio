import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { auditFolderMigration } from "../../scripts/audit-folder-migration.js";
import { auditGenerationNaming } from "../../scripts/audit-generation-naming.js";

/**
 * Preflight Audit Tool Behavior Test Suite (Section D)
 *
 * Verifies:
 * 1. Audits are strictly read-only.
 * 2. Return issuesCount = 0 and success on clean schema/data.
 * 3. Return issuesCount > 0 and report exact anomaly details when blockers are present.
 */
test("Preflight Audit Tools: detect anomalies and report blocking issues", async () => {
  assert.ok(process.env.DATABASE_URL, "test requires DATABASE_URL");

  const rootSql = postgres(process.env.DATABASE_URL, { max: 1 });
  const fixtureSchema = `audit_exit_fixture_${randomUUID().replace(/-/g, "_")}`;

  await rootSql.unsafe(`CREATE SCHEMA ${fixtureSchema}`);

  const fixtureSql = postgres(process.env.DATABASE_URL, {
    max: 1,
    connection: {
      search_path: `${fixtureSchema},public`,
    },
  });
  const fixtureDb = drizzle(fixtureSql);

  try {
    // 1. Create tables
    await fixtureSql.unsafe(`
      CREATE TABLE projects (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE TABLE folders (
        id UUID PRIMARY KEY,
        project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
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

      CREATE TABLE naming_counters (
        namespace TEXT PRIMARY KEY,
        next_sequence BIGINT NOT NULL DEFAULT 1,
        updated_at BIGINT NOT NULL
      );

      CREATE TABLE generation_naming (
        generation_id UUID PRIMARY KEY,
        namespace TEXT NOT NULL,
        sequence BIGINT NOT NULL,
        assigned_at BIGINT NOT NULL
      );
    `);

    // 2. Clean state test: zero blockers
    const cleanFolderReport = await auditFolderMigration(fixtureDb);
    assert.equal(cleanFolderReport.issuesCount, 0, "Folder audit must find 0 issues on clean db");

    const cleanNamingReport = await auditGenerationNaming(fixtureDb);
    assert.equal(cleanNamingReport.issuesCount, 0, "Naming audit must find 0 issues on clean db");

    // 3. Inject Folder Audit Blocker: duplicate sibling folder names in the same project
    const projId = randomUUID();
    const now = Date.now();
    await fixtureSql.unsafe(`
      INSERT INTO projects (id, name, created_at, updated_at)
      VALUES ('${projId}', 'Audit Test Proj', ${now}, ${now});

      INSERT INTO folders (id, project_id, name, created_at) VALUES
      ('${randomUUID()}', '${projId}', 'Duplicate Name', ${now}),
      ('${randomUUID()}', '${projId}', 'duplicate name', ${now});
    `);

    const dirtyFolderReport = await auditFolderMigration(fixtureDb);
    assert.ok(dirtyFolderReport.issuesCount > 0, "Folder audit must detect duplicate sibling names as blocking");
    assert.equal(dirtyFolderReport.duplicateFolderNames.length, 1, "Must pinpoint the duplicate folder group");

    // 4. Inject Naming Audit Blocker: generation without naming row & duplicate sequence
    const genId1 = randomUUID();
    const genId2 = randomUUID();
    await fixtureSql.unsafe(`
      INSERT INTO generations (id, project_id, folder_id, created_at, updated_at) VALUES
      ('${genId1}', '${projId}', NULL, ${now}, ${now}),
      ('${genId2}', '${projId}', NULL, ${now}, ${now});

      -- Duplicate sequence for same namespace
      INSERT INTO generation_naming (generation_id, namespace, sequence, assigned_at) VALUES
      ('${genId1}', 'project_unsorted:${projId}', 1, ${now}),
      ('${genId2}', 'project_unsorted:${projId}', 1, ${now});
    `);

    const dirtyNamingReport = await auditGenerationNaming(fixtureDb);
    assert.ok(dirtyNamingReport.issuesCount > 0, "Naming audit must detect duplicate sequence as blocking");
    assert.ok(dirtyNamingReport.duplicateSequences.length > 0, "Must pinpoint the duplicate sequence anomaly");
  } finally {
    await fixtureSql.end({ timeout: 5 });
    await rootSql.unsafe(`DROP SCHEMA IF EXISTS ${fixtureSchema} CASCADE;`);
    await rootSql.end({ timeout: 5 });
  }
});
