import { NextRequest, NextResponse } from "next/server";
import { getBoard, saveBoardData } from "@/lib/canvas-db";
import { validateCanvasState } from "@/lib/canvas/serialization";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";

/** GET /api/canvas-boards/[id] -> CanvasBoard (incl. `data`), or 404. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  const { id } = await params;
  const board = await getBoard(id);
  if (!board) {
    return NextResponse.json({ error: "Board not found." }, { status: 404 });
  }
  return NextResponse.json(board);
}

/** PUT /api/canvas-boards/[id] { data: CanvasState } -> { ok, updatedAt } (autosave). */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  const { id } = await params;
  const b = await req.json().catch(() => ({}));

  // validateCanvasState() never throws (it always coerces to a well-formed
  // state — see serialization.ts), so the shape check for a malformed/
  // missing body happens here, before coercion, to still surface a 400.
  if (b.data == null || typeof b.data !== "object" || Array.isArray(b.data)) {
    return NextResponse.json({ error: "Invalid board data." }, { status: 400 });
  }

  // Board JSON is meant to be small structured data (image nodes only ever
  // hold a /api/media URL, never embedded bytes) and autosaves fire every
  // ~1.5s — cap it generously so a buggy/malicious client can't grow this
  // jsonb column unbounded.
  const MAX_BOARD_JSON_BYTES = 2 * 1024 * 1024;
  if (JSON.stringify(b.data).length > MAX_BOARD_JSON_BYTES) {
    return NextResponse.json({ error: "Board is too large to save." }, { status: 413 });
  }

  const data = validateCanvasState(b.data);
  const result = await saveBoardData(id, data);
  if (!result) {
    return NextResponse.json({ error: "Board not found." }, { status: 404 });
  }
  return NextResponse.json({ ok: true, updatedAt: result.updatedAt });
}
