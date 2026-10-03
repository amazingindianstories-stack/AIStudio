import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { adminOrNull } from "@/lib/admin";
import { verifyCronSecret } from "@/lib/cron-auth";

export const runtime = "nodejs";

const COORDINATOR_STATEMENTS = [
  "alter table generations add column if not exists provider_responses jsonb",
  "alter table generations add column if not exists submitted_at bigint",
  "alter table generations add column if not exists provider_created_at bigint",
  "alter table generations add column if not exists provider_updated_at bigint",
  "alter table generations add column if not exists completed_at bigint",
  "alter table generations add column if not exists last_poll_at bigint",
  "alter table generations add column if not exists next_poll_at bigint",
  "alter table generations add column if not exists poll_attempts integer not null default 0",
  "alter table generations add column if not exists callback_received_at bigint",
  "alter table generations add column if not exists provider_status text",
  "alter table generations add column if not exists worker_lease_id text",
  "alter table generations add column if not exists worker_lease_until bigint",
  "alter table generations add column if not exists source_generation_id uuid",
  "alter table generations add column if not exists draft_task_id text",
  "alter table generations add column if not exists draft_mode boolean",
  "alter table generations add column if not exists bitrate_mode text",
  "alter table generations add column if not exists last_frame_url text",
  "alter table generations add column if not exists reference_videos jsonb",
  "alter table generations add column if not exists reference_audios jsonb",
  "alter table generations add column if not exists video_task_mode text default 'generate'",
  "create index if not exists generations_coordinator_due_idx on generations (status, next_poll_at, created_at) where kind in ('video', 'image') and status in ('queued', 'running')",
];

const PORTRAIT_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS portrait_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    byteplus_group_id TEXT UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    group_type TEXT NOT NULL DEFAULT 'AIGC',
    project_name TEXT NOT NULL DEFAULT 'default',
    primary_asset_id TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS portrait_assets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
  )`,
  "CREATE INDEX IF NOT EXISTS idx_portrait_assets_group_id ON portrait_assets(group_id)",
];

const PROJECT_BINDING_STATEMENTS = [
  "ALTER TABLE assets ADD COLUMN IF NOT EXISTS project_id UUID",
  "CREATE INDEX IF NOT EXISTS assets_project_id_idx ON assets (project_id)",
  "ALTER TABLE portrait_groups ADD COLUMN IF NOT EXISTS project_id UUID",
  "CREATE INDEX IF NOT EXISTS portrait_groups_project_id_idx ON portrait_groups (project_id)",
];

const MEDIA_EXPORT_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS media_exports (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    total_items INTEGER NOT NULL DEFAULT 0,
    processed_items INTEGER NOT NULL DEFAULT 0,
    skipped_items INTEGER NOT NULL DEFAULT 0,
    warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    lease_owner TEXT,
    lease_until BIGINT,
    output_key TEXT,
    output_bytes BIGINT,
    error TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    expires_at BIGINT
  )`,
  `CREATE TABLE IF NOT EXISTS media_export_items (
    export_id UUID NOT NULL REFERENCES media_exports(id) ON DELETE CASCADE,
    generation_id UUID NOT NULL,
    position INTEGER NOT NULL,
    source_key TEXT NOT NULL,
    filename TEXT NOT NULL,
    PRIMARY KEY (export_id, generation_id)
  )`,
  "CREATE INDEX IF NOT EXISTS media_exports_user_created_idx ON media_exports(user_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS media_exports_worker_due_idx ON media_exports(status, lease_until, created_at)",
  "CREATE INDEX IF NOT EXISTS media_export_items_order_idx ON media_export_items(export_id, position)",
];

const HIERARCHICAL_FOLDER_STATEMENTS = [
  "ALTER TABLE folders ALTER COLUMN project_id DROP NOT NULL",
  "ALTER TABLE folders ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES folders(id) ON DELETE RESTRICT",
  "ALTER TABLE folders ADD COLUMN IF NOT EXISTS name_normalized TEXT",
  "ALTER TABLE folders ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE folders ADD COLUMN IF NOT EXISTS updated_at BIGINT NOT NULL DEFAULT 0",
  "ALTER TABLE generations ADD COLUMN IF NOT EXISTS location_version INTEGER NOT NULL DEFAULT 1",
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'folders_project_id_fkey') THEN
      ALTER TABLE folders ADD CONSTRAINT folders_project_id_fkey FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT;
    END IF;
  END $$;`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'folders_parent_id_fkey') THEN
      ALTER TABLE folders ADD CONSTRAINT folders_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE RESTRICT;
    END IF;
  END $$;`,
  `DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'generations_project_id_fkey') THEN
      ALTER TABLE generations DROP CONSTRAINT generations_project_id_fkey;
    END IF;
  END $$;`,
  `DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'generations_folder_id_fkey') THEN
      ALTER TABLE generations DROP CONSTRAINT generations_folder_id_fkey;
    END IF;
  END $$;`,
  "UPDATE folders SET name_normalized = LOWER(TRIM(NORMALIZE(name, NFKC))) WHERE name_normalized IS NULL OR name_normalized = ''",
  "ALTER TABLE folders ALTER COLUMN name_normalized SET DEFAULT ''",
  "ALTER TABLE folders ALTER COLUMN name_normalized SET NOT NULL",
  "UPDATE folders SET updated_at = created_at WHERE updated_at = 0 OR updated_at IS NULL",
  "ALTER TABLE folders ALTER COLUMN updated_at SET DEFAULT 0",
  "CREATE INDEX IF NOT EXISTS folders_project_id_idx ON folders(project_id)",
  "CREATE INDEX IF NOT EXISTS folders_parent_id_idx ON folders(parent_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS folders_global_root_unique_idx ON folders(name_normalized) WHERE parent_id IS NULL AND project_id IS NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS folders_project_root_unique_idx ON folders(project_id, name_normalized) WHERE parent_id IS NULL AND project_id IS NOT NULL",
  "CREATE UNIQUE INDEX IF NOT EXISTS folders_subfolder_unique_idx ON folders(parent_id, name_normalized) WHERE parent_id IS NOT NULL",
  `CREATE OR REPLACE FUNCTION sync_folder_name_normalized()
   RETURNS TRIGGER AS $$
   BEGIN
     IF NEW.name IS NOT NULL THEN
       NEW.name_normalized := LOWER(TRIM(NORMALIZE(NEW.name, NFKC)));
     END IF;
     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql`,
  "DROP TRIGGER IF EXISTS trg_sync_folder_name_normalized ON folders",
  "CREATE TRIGGER trg_sync_folder_name_normalized BEFORE INSERT OR UPDATE OF name ON folders FOR EACH ROW EXECUTE FUNCTION sync_folder_name_normalized()",
  `CREATE OR REPLACE FUNCTION check_folder_scope_integrity()
   RETURNS TRIGGER AS $$
   DECLARE
     parent_proj UUID;
   BEGIN
     IF NEW.parent_id IS NOT NULL THEN
       SELECT project_id INTO parent_proj FROM folders WHERE id = NEW.parent_id;
       IF NOT FOUND THEN
         RAISE EXCEPTION 'Parent folder % does not exist', NEW.parent_id USING ERRCODE = 'foreign_key_violation';
       END IF;
       IF NEW.project_id IS DISTINCT FROM parent_proj THEN
         RAISE EXCEPTION 'Folder scope mismatch: child project_id (%) does not match parent project_id (%)',
           NEW.project_id, parent_proj USING ERRCODE = 'check_violation';
       END IF;
     END IF;
     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql`,
  "DROP TRIGGER IF EXISTS trg_check_folder_scope ON folders",
  "CREATE CONSTRAINT TRIGGER trg_check_folder_scope AFTER INSERT OR UPDATE OF parent_id, project_id ON folders DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_folder_scope_integrity()",
  `CREATE OR REPLACE FUNCTION check_generation_scope_integrity()
   RETURNS TRIGGER AS $$
   DECLARE
     folder_proj UUID;
   BEGIN
     IF NEW.folder_id IS NOT NULL THEN
       SELECT project_id INTO folder_proj FROM folders WHERE id = NEW.folder_id;
       IF FOUND AND NEW.project_id IS DISTINCT FROM folder_proj THEN
         RAISE EXCEPTION 'Generation scope mismatch: generation project_id (%) does not match folder project_id (%)',
           NEW.project_id, folder_proj USING ERRCODE = 'check_violation';
       END IF;
     END IF;
     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql`,
  "DROP TRIGGER IF EXISTS trg_check_generation_scope ON generations",
  "CREATE CONSTRAINT TRIGGER trg_check_generation_scope AFTER INSERT OR UPDATE OF folder_id, project_id ON generations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_generation_scope_integrity()",
  `CREATE TABLE IF NOT EXISTS organization_idempotency_keys (
     key TEXT PRIMARY KEY,
     result JSONB NOT NULL,
     created_at BIGINT NOT NULL
   )`,
  "CREATE INDEX IF NOT EXISTS organization_idempotency_keys_created_idx ON organization_idempotency_keys(created_at)",
];

/**
 * POST /api/admin/migrate-schema
 * One-time online schema migration endpoint for production deployments.
 * Authorized by admin session, CRON_SECRET, or optional MIGRATION_TOKEN.
 */
export async function POST(request) {
  const admin = await adminOrNull();
  const cronAuth = verifyCronSecret(request);
  const migrationToken = process.env.MIGRATION_TOKEN;
  const tokenAuth = migrationToken && request.headers.get("x-migration-token") === migrationToken;
  const setupSecret = process.env.SET_TOKEN_SECRET;
  const setupAuth = setupSecret && request.headers.get("x-setup-secret") === setupSecret;

  if (!admin && !cronAuth && !tokenAuth && !setupAuth) {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  try {
    const db = await getDb();

    // 1. Apply coordinator columns and index
    for (const stmt of COORDINATOR_STATEMENTS) {
      await db.execute(sql.raw(stmt));
    }

    // 2. Apply portrait tables and index
    for (const stmt of PORTRAIT_STATEMENTS) {
      await db.execute(sql.raw(stmt));
    }

    // 3. Apply project binding columns and indexes
    for (const stmt of PROJECT_BINDING_STATEMENTS) {
      await db.execute(sql.raw(stmt));
    }

    // 4. Apply media export tables and indexes
    for (const stmt of MEDIA_EXPORT_STATEMENTS) {
      await db.execute(sql.raw(stmt));
    }

    // 5. Apply hierarchical folder statements and indexes
    for (const stmt of HIERARCHICAL_FOLDER_STATEMENTS) {
      await db.execute(sql.raw(stmt));
    }

    // 6. Verify schema state
    const coordinatorVerification = await db.execute(sql`
      select count(*)::int as count
      from information_schema.columns
      where table_name = 'generations'
        and column_name in (
          'provider_responses',
          'submitted_at', 'provider_created_at', 'provider_updated_at',
          'completed_at', 'last_poll_at', 'next_poll_at', 'poll_attempts',
          'callback_received_at', 'provider_status', 'worker_lease_id', 'worker_lease_until',
          'source_generation_id', 'draft_task_id', 'draft_mode', 'bitrate_mode', 'last_frame_url',
          'reference_videos', 'reference_audios', 'video_task_mode', 'location_version'
        );
    `);

    const portraitTablesVerification = await db.execute(sql`
      select count(*)::int as count
      from information_schema.tables
      where table_name in ('portrait_groups', 'portrait_assets');
    `);

    const mediaExportTablesVerification = await db.execute(sql`
      select count(*)::int as count
      from information_schema.tables
      where table_name in ('media_exports', 'media_export_items');
    `);

    const hierarchicalFolderColumnsVerification = await db.execute(sql`
      select count(*)::int as count
      from information_schema.columns
      where table_name = 'folders'
        and column_name in ('parent_id', 'name_normalized', 'version', 'updated_at');
    `);

    const coordCount = Number((coordinatorVerification.rows ?? coordinatorVerification)[0]?.count || 0);
    const portCount = Number((portraitTablesVerification.rows ?? portraitTablesVerification)[0]?.count || 0);
    const mediaExportCount = Number((mediaExportTablesVerification.rows ?? mediaExportTablesVerification)[0]?.count || 0);
    const folderColCount = Number((hierarchicalFolderColumnsVerification.rows ?? hierarchicalFolderColumnsVerification)[0]?.count || 0);

    return NextResponse.json({
      success: true,
      coordinatorColumns: coordCount,
      portraitTables: portCount,
      mediaExportTables: mediaExportCount,
      hierarchicalFolderColumns: folderColCount,
      verified: coordCount === 21 && portCount === 2 && mediaExportCount === 2 && folderColCount === 4,
    });
  } catch (error) {
    console.error("[migrate-schema] Error applying migration:", error);
    return NextResponse.json(
      { error: error?.message || "Migration failed" },
      { status: 500 }
    );
  }
}
