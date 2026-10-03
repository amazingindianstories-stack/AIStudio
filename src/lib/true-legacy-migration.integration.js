import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { HIERARCHICAL_FOLDER_STATEMENTS } from "../../scripts/migrate-hierarchical-folders.js";
import { auditFolderMigration } from "../../scripts/audit-folder-migration.js";
import { verifyProductionSchema } from "../../scripts/verify-production-schema.js";

/**
 * True Prior-Release PostgreSQL Schema Migration Test.
 *
 * This test fulfills the audit requirement:
 * "Build a true prior-release PostgreSQL schema fixture, seed old production-shaped rows,
 * test preflight, migration, second migration and post-upgrade checks in dedicated CI;
 * do not label inserts into the final Drizzle schema as a legacy-schema migration test.
 * Investigate and remediate stale nonempty normalized keys; do not silently rewrite conflicting real data."
 */
test("True legacy PostgreSQL schema fixture: preflight, migration, second migration, and post-upgrade invariants", async () => {
  assert.ok(process.env.DATABASE_URL, "test requires DATABASE_URL");

  const rootSql = postgres(process.env.DATABASE_URL, { max: 1 });
  const fixtureSchema = `legacy_fixture_${randomUUID().replace(/-/g, "_")}`;

  await rootSql.unsafe(`CREATE SCHEMA ${fixtureSchema}`);

  // Create dedicated fixture connection bound to fixtureSchema
  const fixtureSql = postgres(process.env.DATABASE_URL, {
    max: 1,
    connection: {
      search_path: `${fixtureSchema},public`,
    },
  });
  const fixtureDb = drizzle(fixtureSql);

  try {
    // 1. Provision the TRUE PRE-HIERARCHICAL LEGACY SCHEMA
    // Notice: folders.project_id NOT NULL, NO parent_id, NO name_normalized, NO version, NO updated_at
    // generations: NO location_version, and organization_idempotency_keys does NOT exist
    await fixtureSql.unsafe(`
      CREATE TABLE users (
        id UUID PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        color TEXT,
        avatar_url TEXT,
        is_active BOOLEAN NOT NULL DEFAULT true,
        auth_version INTEGER NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL
      );

      CREATE TABLE projects (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL,
        brief TEXT,
        created_by UUID,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE TABLE pricing (
        model TEXT PRIMARY KEY,
        unit_cost_cents INTEGER NOT NULL,
        unit TEXT NOT NULL,
        notes TEXT
      );

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE TABLE user_limits (
        user_id UUID NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, key)
      );

      CREATE TABLE canvas_boards (
        id UUID PRIMARY KEY,
        project_id UUID NOT NULL,
        name TEXT NOT NULL,
        data JSONB NOT NULL,
        created_by UUID,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE TABLE agent_conversations (
        id UUID PRIMARY KEY,
        project_id UUID NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'chat',
        agent_kind TEXT,
        created_by UUID,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE TABLE agent_conversation_messages (
        id UUID PRIMARY KEY,
        conversation_id UUID NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_trace JSONB,
        created_at BIGINT NOT NULL
      );

      CREATE TABLE activity_logs (
        id UUID PRIMARY KEY,
        user_id UUID,
        action TEXT NOT NULL,
        detail JSONB,
        created_at BIGINT NOT NULL
      );

      CREATE TABLE login_attempts (
        id UUID PRIMARY KEY,
        identifier TEXT NOT NULL,
        created_at BIGINT NOT NULL
      );

      CREATE TABLE assets (
        id UUID PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        description TEXT,
        images JSONB NOT NULL DEFAULT '[]',
        project_id UUID,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE TABLE portrait_groups (
        id UUID PRIMARY KEY,
        byteplus_group_id TEXT UNIQUE,
        name TEXT NOT NULL,
        description TEXT,
        group_type TEXT NOT NULL DEFAULT 'AIGC',
        project_name TEXT NOT NULL DEFAULT 'default',
        primary_asset_id TEXT,
        project_id UUID,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE TABLE portrait_assets (
        id UUID PRIMARY KEY,
        group_id UUID NOT NULL REFERENCES portrait_groups(id) ON DELETE CASCADE,
        byteplus_asset_id TEXT UNIQUE,
        name TEXT,
        asset_type TEXT NOT NULL DEFAULT 'Image',
        role TEXT NOT NULL DEFAULT 'reference',
        image_url TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'Processing',
        status_message TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE TABLE depth_workers (
        id UUID PRIMARY KEY,
        worker_id TEXT NOT NULL UNIQUE,
        label TEXT,
        device TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        current_job_id UUID,
        current_claim_id UUID,
        protocol_version INTEGER NOT NULL DEFAULT 1,
        ram_limit_mb INTEGER,
        ram_used_mb INTEGER,
        last_seen_at BIGINT NOT NULL,
        created_at BIGINT NOT NULL
      );

      CREATE TABLE media_exports (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        total_items INTEGER NOT NULL DEFAULT 0,
        processed_items INTEGER NOT NULL DEFAULT 0,
        skipped_items INTEGER NOT NULL DEFAULT 0,
        warnings JSONB NOT NULL DEFAULT '[]',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        lease_until BIGINT,
        output_key TEXT,
        output_bytes BIGINT,
        error TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        expires_at BIGINT
      );

      CREATE TABLE media_export_items (
        export_id UUID NOT NULL REFERENCES media_exports(id) ON DELETE CASCADE,
        generation_id UUID NOT NULL,
        position INTEGER NOT NULL,
        source_key TEXT NOT NULL,
        filename TEXT NOT NULL,
        PRIMARY KEY (export_id, generation_id)
      );

      CREATE TABLE folders (
        id UUID PRIMARY KEY,
        project_id UUID NOT NULL,
        name TEXT NOT NULL,
        created_at BIGINT NOT NULL
      );

      CREATE TABLE generations (
        id UUID PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        prompt TEXT NOT NULL,
        model TEXT NOT NULL,
        aspect_ratio TEXT NOT NULL,
        resolution TEXT,
        duration INTEGER,
        url TEXT,
        poster TEXT,
        error TEXT,
        provider_responses JSONB,
        moderation_blocked BOOLEAN,
        reference_images JSONB,
        reference_videos JSONB,
        reference_audios JSONB,
        project_id UUID,
        folder_id UUID,
        user_id UUID,
        cost_cents INTEGER NOT NULL DEFAULT 0,
        cost_basis TEXT NOT NULL DEFAULT 'estimated',
        is_favorite BOOLEAN NOT NULL DEFAULT false,
        favorited_at BIGINT,
        task_id TEXT,
        source_generation_id UUID,
        draft_task_id TEXT,
        submitted_at BIGINT,
        provider_created_at BIGINT,
        provider_updated_at BIGINT,
        completed_at BIGINT,
        last_poll_at BIGINT,
        next_poll_at BIGINT,
        poll_attempts INTEGER NOT NULL DEFAULT 0,
        callback_received_at BIGINT,
        provider_status TEXT,
        worker_lease_id TEXT,
        worker_lease_until BIGINT,
        poll_error_count INTEGER NOT NULL DEFAULT 0,
        last_poll_error_at BIGINT,
        generate_audio BOOLEAN,
        draft_mode BOOLEAN,
        bitrate_mode TEXT,
        video_task_mode TEXT,
        progress_percent INTEGER,
        progress_message TEXT,
        track_characters BOOLEAN,
        depth_claim_id UUID,
        depth_claim_worker_id TEXT,
        depth_reap_attempts INTEGER NOT NULL DEFAULT 0,
        seed INTEGER,
        candidate_task_ids JSONB,
        continuation_frame_url TEXT,
        last_frame_url TEXT,
        flagged BOOLEAN NOT NULL DEFAULT false,
        flagged_at BIGINT,
        flag_reason TEXT,
        judge_score JSONB,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
    `);

    // 2. Seed real production-shaped legacy rows
    const now = Date.now();
    const p1Id = randomUUID();
    const p2Id = randomUUID();
    const f1Id = randomUUID();
    const f2Id = randomUUID();
    const fSpacesId = randomUUID();
    const fP2Id = randomUUID();
    const g1Id = randomUUID();
    const gUnsorted1Id = randomUUID();
    const gGlobalId = randomUUID();

    await fixtureSql.unsafe(`
      INSERT INTO projects (id, name, brief, created_at, updated_at) VALUES
        ('${p1Id}', 'Legacy Project 1', 'Brief 1', ${now}, ${now}),
        ('${p2Id}', 'Legacy Project 2', 'Brief 2', ${now}, ${now});

      INSERT INTO folders (id, project_id, name, created_at) VALUES
        ('${f1Id}', '${p1Id}', 'Legacy Flat Folder 1', ${now - 1000}),
        ('${f2Id}', '${p1Id}', 'Café', ${now - 2000}),
        ('${fSpacesId}', '${p1Id}', 'Folder With Spaces   ', ${now - 3000}),
        ('${fP2Id}', '${p2Id}', 'Legacy Flat Folder 1', ${now - 4000});

      INSERT INTO generations (id, kind, status, prompt, model, aspect_ratio, project_id, folder_id, created_at, updated_at) VALUES
        ('${g1Id}', 'image', 'succeeded', 'Gen in F1', 'flux', '1:1', '${p1Id}', '${f1Id}', ${now - 500}, ${now - 500}),
        ('${gUnsorted1Id}', 'image', 'succeeded', 'Gen Unsorted in P1', 'flux', '1:1', '${p1Id}', NULL, ${now - 600}, ${now - 600}),
        ('${gGlobalId}', 'image', 'succeeded', 'Global Gen', 'flux', '1:1', NULL, NULL, ${now - 700}, ${now - 700});
    `);

    // 3. Test Preflight Audit: Sibling Collision Detection
    // Seed a Unicode collision in p1: decomposed "Cafe\u0301" vs precomposed "Café"
    const fCollisionId = randomUUID();
    await fixtureSql.unsafe(`
      INSERT INTO folders (id, project_id, name, created_at) VALUES
        ('${fCollisionId}', '${p1Id}', 'Cafe\u0301', ${now});
    `);

    const preflightCollReport = await auditFolderMigration(fixtureDb);
    assert.equal(preflightCollReport.duplicateFolderNames.length, 1, "Preflight must detect Unicode NFKC collision");
    assert.equal(preflightCollReport.duplicateFolderNames[0].normalizedName, "café");
    assert.equal(preflightCollReport.duplicateFolderNames[0].count, 2);

    // Remediate the collision non-destructively before running migration
    await fixtureSql.unsafe(`
      UPDATE folders SET name = 'Café Alternative' WHERE id = '${fCollisionId}';
    `);

    const preflightCleanReport = await auditFolderMigration(fixtureDb);
    assert.equal(preflightCleanReport.duplicateFolderNames.length, 0, "Preflight must pass once collision is resolved");
    assert.equal(preflightCleanReport.foldersCount, 5);
    assert.equal(preflightCleanReport.projectsCount, 2);
    assert.equal(preflightCleanReport.generationsCount, 3);

    // 4. Apply the hierarchical folders additive migration
    for (const statement of HIERARCHICAL_FOLDER_STATEMENTS) {
      await fixtureSql.unsafe(statement);
    }

    // 5. Test Migration Idempotency: Run all migration statements a SECOND time
    for (const statement of HIERARCHICAL_FOLDER_STATEMENTS) {
      await fixtureSql.unsafe(statement);
    }

    // 6. Verify Post-Upgrade Schema & Invariants
    const folderColsRes = await fixtureSql.unsafe(`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = '${fixtureSchema}' AND table_name = 'folders';
    `);
    const folderCols = new Map(folderColsRes.map((r) => [r.column_name, r]));
    assert.ok(folderCols.has("parent_id"), "folders.parent_id column must exist");
    assert.ok(folderCols.has("name_normalized"), "folders.name_normalized column must exist");
    assert.ok(folderCols.has("version"), "folders.version column must exist");
    assert.ok(folderCols.has("updated_at"), "folders.updated_at column must exist");
    assert.equal(folderCols.get("project_id").is_nullable, "YES", "folders.project_id must be nullable for global folders");

    const genColsRes = await fixtureSql.unsafe(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = '${fixtureSchema}' AND table_name = 'generations';
    `);
    const genCols = new Set(genColsRes.map((r) => r.column_name));
    assert.ok(genCols.has("location_version"), "generations.location_version column must exist");

    // Check indexes
    const indexRes = await fixtureSql.unsafe(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = '${fixtureSchema}' AND tablename = 'folders';
    `);
    const indexes = new Set(indexRes.map((r) => r.indexname));
    assert.ok(indexes.has("folders_project_id_idx"));
    assert.ok(indexes.has("folders_parent_id_idx"));
    assert.ok(indexes.has("folders_global_root_unique_idx"));
    assert.ok(indexes.has("folders_project_root_unique_idx"));
    assert.ok(indexes.has("folders_subfolder_unique_idx"));

    // Check foreign keys
    const fkRes = await fixtureSql.unsafe(`
      SELECT conname
      FROM pg_constraint
      WHERE contype = 'f' AND connamespace = (SELECT oid FROM pg_namespace WHERE nspname = '${fixtureSchema}');
    `);
    const fks = new Set(fkRes.map((r) => r.conname));
    assert.ok(fks.has("folders_project_id_fkey"), "folders_project_id_fkey must exist");
    assert.ok(fks.has("folders_parent_id_fkey"), "folders_parent_id_fkey must exist");
    assert.ok(fks.has("generations_project_id_fkey"), "generations_project_id_fkey must exist");
    assert.ok(fks.has("generations_folder_id_fkey"), "generations_folder_id_fkey must exist");

    // Check triggers
    const trgRes = await fixtureSql.unsafe(`
      SELECT trigger_name
      FROM information_schema.triggers
      WHERE trigger_schema = '${fixtureSchema}';
    `);
    const trgs = new Set(trgRes.map((r) => r.trigger_name));
    assert.ok(trgs.has("trg_sync_folder_name_normalized"), "trg_sync_folder_name_normalized must exist");
    assert.ok(trgs.has("trg_check_folder_scope"), "trg_check_folder_scope must exist");
    assert.ok(trgs.has("trg_check_generation_scope"), "trg_check_generation_scope must exist");

    // Check data preservation and defaults
    const migratedFolders = await fixtureSql.unsafe(`
      SELECT id, name, name_normalized, project_id, parent_id, version, updated_at
      FROM folders;
    `);
    assert.equal(migratedFolders.length, 5, "All 5 legacy folders must be preserved");

    const f1 = migratedFolders.find((f) => f.id === f1Id);
    assert.equal(f1.name_normalized, "legacy flat folder 1");
    assert.equal(f1.version, 1);
    assert.equal(f1.parent_id, null);
    assert.equal(Number(f1.updated_at), now - 1000, "updated_at must be backfilled from created_at");

    const fSpaces = migratedFolders.find((f) => f.id === fSpacesId);
    assert.equal(fSpaces.name_normalized, "folder with spaces", "Whitespace must be trimmed in name_normalized");

    // Run official post-upgrade verifier on this migrated schema!
    const verified = await verifyProductionSchema(fixtureDb);
    assert.equal(verified, true, "verifyProductionSchema must pass on migrated database");

    // 7. Test New Hierarchical Functionality on Migrated Database
    // Global root folder
    const globalFolderId = randomUUID();
    await fixtureSql.unsafe(`
      INSERT INTO folders (id, project_id, parent_id, name, created_at, updated_at)
      VALUES ('${globalFolderId}', NULL, NULL, 'Global Root Folder', ${now}, ${now});
    `);

    // Nested subfolder
    const subFolderId = randomUUID();
    await fixtureSql.unsafe(`
      INSERT INTO folders (id, project_id, parent_id, name, created_at, updated_at)
      VALUES ('${subFolderId}', '${p1Id}', '${f1Id}', 'Subfolder in F1', ${now}, ${now});
    `);

    // Subtree generation
    const subGenId = randomUUID();
    await fixtureSql.unsafe(`
      INSERT INTO generations (id, kind, status, prompt, model, aspect_ratio, project_id, folder_id, created_at, updated_at)
      VALUES ('${subGenId}', 'image', 'succeeded', 'Nested Generation', 'flux', '1:1', '${p1Id}', '${subFolderId}', ${now}, ${now});
    `);

    // Verify trigger rejection for invalid scope on migrated database
    await assert.rejects(
      async () => {
        await fixtureSql.unsafe(`
          INSERT INTO folders (id, project_id, parent_id, name, created_at, updated_at)
          VALUES ('${randomUUID()}', '${p2Id}', '${subFolderId}', 'Scope Mismatch Child', ${now}, ${now});
        `);
      },
      /Folder scope mismatch|check_folder_scope|check_violation/i,
      "Must reject scope mismatch child on migrated schema"
    );

    // Verify trigger updates name_normalized on rename
    await fixtureSql.unsafe(`
      UPDATE folders SET name = 'Renamed Café \u00e9' WHERE id = '${f2Id}';
    `);
    const [renamedF2] = await fixtureSql.unsafe(`SELECT name_normalized FROM folders WHERE id = '${f2Id}';`);
    assert.equal(renamedF2.name_normalized, "renamed café é", "Trigger must automatically update name_normalized on rename");
  } finally {
    // 8. Clean up
    await fixtureSql.end({ timeout: 5 });
    await rootSql.unsafe(`DROP SCHEMA IF EXISTS ${fixtureSchema} CASCADE;`);
    await rootSql.end({ timeout: 5 });
  }
});
