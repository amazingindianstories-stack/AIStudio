import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getOwnedMediaExport } from "@/lib/media-exports-db";

export const runtime = "nodejs";
export async function GET(_req, { params }) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  const { id } = await params; const row = await getOwnedMediaExport(id, user.id);
  if (!row) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  return NextResponse.json({ id: row.id, status: row.status, totalItems: row.totalItems, processedItems: row.processedItems, skippedItems: row.skippedItems, warnings: row.warnings, error: row.error, expiresAt: row.expiresAt });
}
