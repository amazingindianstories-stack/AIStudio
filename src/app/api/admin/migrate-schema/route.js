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

    // 3. Verify schema state
    const coordinatorVerification = await db.execute(sql`
      select count(*)::int as count
      from information_schema.columns
      where table_name = 'generations'
        and column_name in (
          'provider_responses',
          'submitted_at', 'provider_created_at', 'provider_updated_at',
          'completed_at', 'last_poll_at', 'next_poll_at', 'poll_attempts',
          'callback_received_at', 'provider_status', 'worker_lease_id', 'worker_lease_until'
        );
    `);

    const portraitTablesVerification = await db.execute(sql`
      select count(*)::int as count
      from information_schema.tables
      where table_name in ('portrait_groups', 'portrait_assets');
    `);

    const coordCount = Number((coordinatorVerification.rows ?? coordinatorVerification)[0]?.count || 0);
    const portCount = Number((portraitTablesVerification.rows ?? portraitTablesVerification)[0]?.count || 0);

    return NextResponse.json({
      success: true,
      coordinatorColumns: coordCount,
      portraitTables: portCount,
      verified: coordCount === 12 && portCount === 2,
    });
  } catch (error) {
    console.error("[migrate-schema] Error applying migration:", error);
    return NextResponse.json(
      { error: error?.message || "Migration failed" },
      { status: 500 }
    );
  }
}
