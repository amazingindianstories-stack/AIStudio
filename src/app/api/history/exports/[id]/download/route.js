import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getOwnedMediaExport } from "@/lib/media-exports-db";
import { getSignedReadUrl } from "@/lib/storage";

export const runtime = "nodejs";
export async function GET(_req, { params }) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  const { id } = await params; const row = await getOwnedMediaExport(id, user.id);
  if (!row) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  if (row.status !== "ready" || !row.outputKey) return NextResponse.json({ error: "NOT_READY" }, { status: 409 });
  if (!row.expiresAt || row.expiresAt <= Date.now()) return NextResponse.json({ error: "EXPIRED" }, { status: 410 });
  return NextResponse.redirect(await getSignedReadUrl(row.outputKey, 5 * 60), 307);
}
