import { NextResponse } from "next/server";
import { saveCanvasAsset } from "@/lib/save-media";
import { boardExists } from "@/lib/canvas-db";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * POST /api/canvas-boards/[id]/upload { dataUrl } -> { url }
 * Direct upload/paste path for placing an image node (design.md: not an
 * acceptance criterion, first thing to cut if scope must shrink — the
 * asset-library drag path is the load-bearing one).
 *
 * `[id]` used to be ignored entirely — the handler did not even destructure
 * `params` — so any signed-in user could write bytes into the media bucket
 * under a board id that need not exist and that they had no connection to.
 * The MIME allowlist in `splitDataUrl` (JPEG/PNG/WebP/GIF, SVG rejected) plus
 * MAX_CANVAS_UPLOAD_BYTES bounded that to storage-cost abuse rather than
 * stored XSS, but an upload endpoint that discards its own scope has no way
 * to attribute or clean up what it wrote. The board is resolved first now,
 * and the id namespaces the stored key.
 *
 * Deliberately NOT gated on `canManage`: a board's contents are editable by
 * the whole project (see the PUT autosave route, and canManage's docstring in
 * auth.js) — placing an image is a content edit, not an irreversible one.
 * Existence, not ownership, is what was missing.
 */
export async function POST(req, { params }) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  const { id } = await params;
  if (!(await boardExists(id))) {
    return NextResponse.json({ error: "Board not found." }, { status: 404 });
  }
  const b = await req.json().catch(() => ({}));
  const dataUrl = b.dataUrl;
  if (!dataUrl || typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    return NextResponse.json({ error: "dataUrl required." }, { status: 400 });
  }
  try {
    const url = await saveCanvasAsset(dataUrl, id);
    return NextResponse.json({ url });
  } catch {
    return NextResponse.json({ error: "Upload failed." }, { status: 400 });
  }
}
