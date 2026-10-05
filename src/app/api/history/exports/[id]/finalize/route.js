import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { finalizeMediaExport } from "@/lib/media-exports-db";

export const runtime = "nodejs";
export async function POST(_req, { params }) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  try { const { id } = await params; const row = await finalizeMediaExport(id, user.id); return NextResponse.json({ id: row.id, status: row.status }); }
  catch (error) {
    const message = error?.message?.startsWith("EXPORT_FILENAME_COLLISION")
      ? "Selected assets have duplicate filenames. Export each folder separately or rename the folders."
      : "Export cannot be queued.";
    return NextResponse.json({ error: message }, { status: 409 });
  }
}
