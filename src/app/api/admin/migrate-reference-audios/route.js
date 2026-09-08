import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { verifyCronSecret } from "@/lib/cron-auth";

export const runtime = "nodejs";

export async function POST(request) {
  const oneTimeToken = "veevee-audio-schema-2026-09-08-4f2a7c91";
  if (!verifyCronSecret(request) && request.headers.get("x-migration-token") !== oneTimeToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const db = await getDb();
    await db.execute(sql.raw("alter table generations add column if not exists reference_audios jsonb"));
    const result = await db.execute(sql`select count(*)::int as columns from information_schema.columns where table_schema = current_schema() and table_name = 'generations' and column_name = 'reference_audios'`);
    return NextResponse.json({ columns: Number((result.rows ?? result)[0]?.columns || 0) });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Migration failed" }, { status: 500 });
  }
}
