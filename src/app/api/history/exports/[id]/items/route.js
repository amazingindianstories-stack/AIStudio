import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { appendMediaExportItems } from "@/lib/media-exports-db";

export const runtime = "nodejs";
export async function POST(req, { params }) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  try { return NextResponse.json(await appendMediaExportItems(id, user.id, Array.isArray(body.ids) ? body.ids : [])); }
  catch (error) {
    const code = error?.message;
    const status = code === "EXPORT_NOT_FOUND" ? 404 : code === "EXPORT_NOT_DRAFT" ? 409 : 400;
    return NextResponse.json({ error: code }, { status });
  }
}
