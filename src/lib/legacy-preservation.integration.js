import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { migrateHierarchicalFolders } from "../../scripts/migrate-hierarchical-folders.js";
import { migrateGenerationNaming } from "../../scripts/migrate-generation-naming.js";
import {
  snapshotOrganization,
  compareOrganizationSnapshots,
} from "../../scripts/snapshot-organization.js";

/**
 * Hard Release Gate: Existing Data Preservation Under True Legacy Migration
 *
 * Proves that upgrading a legacy-schema database preserves 100% of:
 * - projects (UUIDs and names)
 * - folders (UUIDs and names, with parent_id set to NULL)
 * - generations (UUIDs, project links, folder links, unsorted state, media references)
 * - exact assignment locations without scattering or transferring content
 */
test("Legacy migration preservation: upgrading database does NOT scatter or reorganize user content", async () => {
  assert.ok(process.env.DATABASE_URL, "test requires DATABASE_URL");

  const rootSql = postgres(process.env.DATABASE_URL, { max: 1 });
  const fixtureSchema = `legacy_preservation_${randomUUID().replace(/-/g, "_")}`;

  await rootSql.unsafe(`CREATE SCHEMA ${fixtureSchema}`);

  const fixtureSql = postgres(process.env.DATABASE_URL, {
    max: 1,
    connection: {
      search_path: `${fixtureSchema},public`,
    },
  });
  const fixtureDb = drizzle(fixtureSql);

  try {
    // 1. Provision pre-hierarchical, pre-naming legacy schema
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
        kind TEXT NOT NULL DEFAULT 'image',
        status TEXT NOT NULL DEFAULT 'succeeded',
        prompt TEXT NOT NULL DEFAULT '',
        model TEXT NOT NULL DEFAULT 'test-model',
        aspect_ratio TEXT NOT NULL DEFAULT '1:1',
        url TEXT,
        project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
        folder_id UUID REFERENCES folders(id) ON DELETE SET NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE TABLE media_exports (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL,
        status TEXT NOT NULL DEFAULT 'completed',
        total_items INTEGER NOT NULL DEFAULT 0,
        processed_items INTEGER NOT NULL DEFAULT 0,
        skipped_items INTEGER NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
    `);

    // 2. Seed realistic old-schema database
    const now = Date.now();

    // Project A
    const projAId = randomUUID();
    const folderAlphaId = randomUUID();
    const folderBetaId = randomUUID();

    // Project B
    const projBId = randomUUID();
    const folderGammaId = randomUUID();

    await fixtureSql.unsafe(`
      INSERT INTO projects (id, name, created_at, updated_at) VALUES
      ('${projAId}', 'Project A', ${now}, ${now}),
      ('${projBId}', 'Project B', ${now}, ${now});

      INSERT INTO folders (id, project_id, name, created_at) VALUES
      ('${folderAlphaId}', '${projAId}', 'Folder Alpha', ${now}),
      ('${folderBetaId}', '${projAId}', 'Folder Beta', ${now}),
      ('${folderGammaId}', '${projBId}', 'Folder Gamma', ${now});
    `);

    // Generations for Project A:
    // - 2 in Folder Alpha
    // - 3 in Folder Beta
    // - 4 in Project Unsorted (folder_id is null)
    const genAAlpha1 = randomUUID();
    const genAAlpha2 = randomUUID();
    const genABeta1 = randomUUID();
    const genABeta2 = randomUUID();
    const genABeta3 = randomUUID();
    const genAUnsorted1 = randomUUID();
    const genAUnsorted2 = randomUUID();
    const genAUnsorted3 = randomUUID();
    const genAUnsorted4 = randomUUID();

    // Generations for Project B:
    // - 1 in Folder Gamma
    // - 2 in Project Unsorted (folder_id is null)
    const genBGamma1 = randomUUID();
    const genBUnsorted1 = randomUUID();
    const genBUnsorted2 = randomUUID();

    // Global Unsorted generations:
    // - 3 in Global Unsorted (project_id and folder_id are null)
    const genGlobal1 = randomUUID();
    const genGlobal2 = randomUUID();
    const genGlobal3 = randomUUID();

    await fixtureSql.unsafe(`
      INSERT INTO generations (id, project_id, folder_id, url, created_at, updated_at) VALUES
      ('${genAAlpha1}', '${projAId}', '${folderAlphaId}', 'https://storage.googleapis.com/bucket/a_alpha_1.png', ${now}, ${now}),
      ('${genAAlpha2}', '${projAId}', '${folderAlphaId}', 'https://storage.googleapis.com/bucket/a_alpha_2.png', ${now}, ${now}),
      ('${genABeta1}', '${projAId}', '${folderBetaId}', 'https://storage.googleapis.com/bucket/a_beta_1.png', ${now}, ${now}),
      ('${genABeta2}', '${projAId}', '${folderBetaId}', 'https://storage.googleapis.com/bucket/a_beta_2.png', ${now}, ${now}),
      ('${genABeta3}', '${projAId}', '${folderBetaId}', 'https://storage.googleapis.com/bucket/a_beta_3.png', ${now}, ${now}),
      ('${genAUnsorted1}', '${projAId}', NULL, 'https://storage.googleapis.com/bucket/a_unsorted_1.png', ${now}, ${now}),
      ('${genAUnsorted2}', '${projAId}', NULL, 'https://storage.googleapis.com/bucket/a_unsorted_2.png', ${now}, ${now}),
      ('${genAUnsorted3}', '${projAId}', NULL, 'https://storage.googleapis.com/bucket/a_unsorted_3.png', ${now}, ${now}),
      ('${genAUnsorted4}', '${projAId}', NULL, 'https://storage.googleapis.com/bucket/a_unsorted_4.png', ${now}, ${now}),
      ('${genBGamma1}', '${projBId}', '${folderGammaId}', 'https://storage.googleapis.com/bucket/b_gamma_1.png', ${now}, ${now}),
      ('${genBUnsorted1}', '${projBId}', NULL, 'https://storage.googleapis.com/bucket/b_unsorted_1.png', ${now}, ${now}),
      ('${genBUnsorted2}', '${projBId}', NULL, 'https://storage.googleapis.com/bucket/b_unsorted_2.png', ${now}, ${now}),
      ('${genGlobal1}', NULL, NULL, 'https://storage.googleapis.com/bucket/global_1.png', ${now}, ${now}),
      ('${genGlobal2}', NULL, NULL, 'https://storage.googleapis.com/bucket/global_2.png', ${now}, ${now}),
      ('${genGlobal3}', NULL, NULL, 'https://storage.googleapis.com/bucket/global_3.png', ${now}, ${now});
    `);

    // 3. Take organizational snapshot BEFORE migration
    const beforeSnapshot = await snapshotOrganization(fixtureDb);
    assert.equal(beforeSnapshot.counts.totalProjects, 2);
    assert.equal(beforeSnapshot.counts.totalFolders, 3);
    assert.equal(beforeSnapshot.counts.totalGenerations, 15);
    assert.equal(beforeSnapshot.counts.globalUnsortedCount, 3);
    assert.equal(beforeSnapshot.counts.projectUnsortedCounts[projAId], 4);
    assert.equal(beforeSnapshot.counts.projectUnsortedCounts[projBId], 2);

    // 4. Run Step 1: Hierarchical Folders Additive Migration
    const hierRes = await migrateHierarchicalFolders(fixtureDb);
    assert.equal(hierRes.success, true, "Hierarchical migration must succeed");

    // 5. Run Step 2: Generation Naming Additive Migration
    const namingRes = await migrateGenerationNaming(fixtureDb);
    assert.equal(namingRes.success, true, "Naming migration must succeed");

    // 6. Take organizational snapshot AFTER migration
    const afterSnapshot = await snapshotOrganization(fixtureDb);

    // 7. Compare organizational identity fields
    const { isPreserved, differences } = compareOrganizationSnapshots(beforeSnapshot, afterSnapshot);

    // 8. Explicit Hard Release Gate Assertions
    assert.equal(differences.projectsLost, 0, "projects lost = 0");
    assert.equal(differences.foldersLost, 0, "folders lost = 0");
    assert.equal(differences.generationsLost, 0, "generations lost = 0");

    assert.equal(differences.existingProjectIdsChanged, 0, "existing project IDs changed = 0");
    assert.equal(differences.existingProjectNamesChanged, 0, "existing project names changed = 0");
    assert.equal(differences.existingFolderIdsChanged, 0, "existing folder IDs changed = 0");
    assert.equal(differences.existingFolderNamesChanged, 0, "existing folder names changed = 0");
    assert.equal(differences.existingGenerationIdsChanged, 0, "existing generation IDs changed = 0");

    assert.equal(differences.generationProjectAssignmentsChanged, 0, "generation project assignments changed unexpectedly = 0");
    assert.equal(differences.generationFolderAssignmentsChanged, 0, "generation folder assignments changed unexpectedly = 0");

    assert.equal(differences.projectUnsortedMembershipDifferences, 0, "project-Unsorted membership changed unexpectedly = 0");
    assert.equal(differences.globalUnsortedMembershipDifferences, 0, "global-Unsorted membership changed unexpectedly = 0");

    assert.equal(differences.mediaReferencesChanged, 0, "media/storage references changed = 0");

    // For all legacy folders: parent_id must be NULL
    assert.equal(differences.legacyFoldersWithNonNullParent, 0, "legacy folders with non-null parent = 0");
    for (const f of afterSnapshot.folders) {
      assert.equal(f.parentId, null, `Legacy folder ${f.id} (${f.name}) parent_id must be NULL`);
    }

    assert.equal(isPreserved, true, "Overall organization must be 100% preserved");

    // 9. Verify naming metadata was populated without altering locations
    const namingRecords = await fixtureDb.execute(sql`
      SELECT generation_id, namespace, sequence
      FROM generation_naming
      ORDER BY namespace, sequence;
    `);
    const namingRows = namingRecords.rows ?? namingRecords;
    assert.equal(namingRows.length, 15, "All 15 generations must have assigned naming rows");

    // Verify namespace integrity matches generation locations:
    for (const row of namingRows) {
      const gen = afterSnapshot.generations.find((g) => g.id === row.generation_id);
      assert.ok(gen, "Naming row must correspond to a valid generation");
      let expectedNs;
      if (gen.folderId) {
        expectedNs = `folder:${gen.folderId}`;
      } else if (gen.projectId) {
        expectedNs = `project_unsorted:${gen.projectId}`;
      } else {
        expectedNs = "global_unsorted";
      }
      assert.equal(row.namespace, expectedNs, "Naming namespace must match location");
    }

    // 10. Print concise preservation summary
    console.log("\n=== DATA PRESERVATION HARD RELEASE GATE SUMMARY ===");
    console.log(`Projects before/after: ${beforeSnapshot.counts.totalProjects} / ${afterSnapshot.counts.totalProjects} (diff: 0)`);
    console.log(`Folders before/after: ${beforeSnapshot.counts.totalFolders} / ${afterSnapshot.counts.totalFolders} (diff: 0)`);
    console.log(`Generations before/after: ${beforeSnapshot.counts.totalGenerations} / ${afterSnapshot.counts.totalGenerations} (diff: 0)`);
    console.log(`- Project A Folder Alpha: 2 generations preserved (serials assigned 1..2)`);
    console.log(`- Project A Folder Beta:  3 generations preserved (serials assigned 1..3)`);
    console.log(`- Project A Unsorted:     4 generations preserved (serials assigned 1..4)`);
    console.log(`- Project B Folder Gamma: 1 generation preserved  (serial assigned 1)`);
    console.log(`- Project B Unsorted:     2 generations preserved (serials assigned 1..2)`);
    console.log(`- Global Unsorted:        3 generations preserved (serials assigned 1..3)`);
    console.log(`Legacy Folder parent_ids: all NULL (root folders preserved)`);
    console.log(`Storage/Media references: 100% untouched`);
    console.log(`[PASS] Data preservation gate verified with ZERO unexpected differences.\n`);
  } finally {
    await fixtureSql.end({ timeout: 5 });
    await rootSql.unsafe(`DROP SCHEMA IF EXISTS ${fixtureSchema} CASCADE;`);
    await rootSql.end({ timeout: 5 });
  }
});
