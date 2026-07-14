import { NextRequest, NextResponse } from "next/server";
import { listBoards, createBoard, renameBoard, deleteBoard, getBoard } from "@/lib/canvas-db";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";

/** GET /api/canvas-boards?projectId=<uuid> -> { boards: CanvasBoardMeta[] } */
export async function GET(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json({ error: "projectId required." }, { status: 400 });
  }
  const boards = await listBoards(projectId);
  return NextResponse.json({ boards });
}

/**
 * Single mutation endpoint, switched on `op` — mirrors api/projects/route.ts
 * for metadata list mutations (createBoard/renameBoard/deleteBoard). The
 * board's `data` blob is never touched here; see [id]/route.ts for that.
 */
export async function POST(req: NextRequest) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  const b = await req.json().catch(() => ({}));
  const op: string = b.op;

  switch (op) {
    case "createBoard": {
      const name = (b.name || "").trim();
      const projectId = b.projectId;
      if (!projectId) {
        return NextResponse.json({ error: "projectId required." }, { status: 400 });
      }
      if (!name) {
        return NextResponse.json({ error: "Name required." }, { status: 400 });
      }
      const board = await createBoard(projectId, name, user.id);
      const boards = await listBoards(projectId);
      return NextResponse.json({ boards, board });
    }
    case "renameBoard": {
      if (!b.id) return NextResponse.json({ error: "id required." }, { status: 400 });
      // design.md's op body is { id, name } (no projectId) — look the board
      // up to scope the returned list, matching op "createBoard"/"deleteBoard".
      const existing = await getBoard(b.id);
      if (!existing) return NextResponse.json({ error: "Board not found." }, { status: 404 });
      await renameBoard(b.id, (b.name || "").trim());
      const boards = await listBoards(existing.projectId);
      return NextResponse.json({ boards });
    }
    case "deleteBoard": {
      if (!b.id) return NextResponse.json({ error: "id required." }, { status: 400 });
      const existing = await getBoard(b.id);
      if (!existing) return NextResponse.json({ error: "Board not found." }, { status: 404 });
      await deleteBoard(b.id);
      const boards = await listBoards(existing.projectId);
      return NextResponse.json({ boards });
    }
    default:
      return NextResponse.json({ error: "Unknown op." }, { status: 400 });
  }
}
