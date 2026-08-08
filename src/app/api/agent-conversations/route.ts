import { NextRequest, NextResponse } from "next/server";
import {
  listConversations,
  ensureLegacyConversation,
  createConversation,
  renameConversation,
  deleteConversation,
  getConversation,
} from "@/lib/agent-conversations-db";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";

/** Legacy first, then chat threads newest-first — the pinned "Old" thread is
 *  always the first entry ThreadSwitcher renders. */
function sortForSwitcher<T extends { kind: string; updatedAt: number }>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    if (a.kind === "legacy") return -1;
    if (b.kind === "legacy") return 1;
    return b.updatedAt - a.updatedAt;
  });
}

/** GET /api/agent-conversations?projectId=<uuid> -> { conversations }.
 *  Auto-creates the pinned "Old" thread on first fetch for a project. */
export async function GET(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json({ error: "projectId required." }, { status: 400 });
  }
  await ensureLegacyConversation(projectId);
  const conversations = sortForSwitcher(await listConversations(projectId));
  return NextResponse.json({ conversations });
}

/** Single mutation endpoint, switched on `op` — mirrors
 *  api/canvas-boards/route.ts's createBoard/renameBoard/deleteBoard shape. */
export async function POST(req: NextRequest) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  const b = await req.json().catch(() => ({}));
  const op: string = b.op;

  switch (op) {
    case "createConversation": {
      const name = (b.name || "").trim();
      const projectId = b.projectId;
      if (!projectId) {
        return NextResponse.json({ error: "projectId required." }, { status: 400 });
      }
      if (!name) {
        return NextResponse.json({ error: "Name required." }, { status: 400 });
      }
      const conversation = await createConversation(projectId, name, user.id);
      const conversations = sortForSwitcher(await listConversations(projectId));
      return NextResponse.json({ conversations, conversation });
    }
    case "renameConversation": {
      if (!b.id) return NextResponse.json({ error: "id required." }, { status: 400 });
      const existing = await getConversation(b.id);
      if (!existing) {
        return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
      }
      if (existing.kind === "legacy") {
        return NextResponse.json({ error: "The Old thread can't be renamed." }, { status: 400 });
      }
      await renameConversation(b.id, (b.name || "").trim());
      const conversations = sortForSwitcher(await listConversations(existing.projectId));
      return NextResponse.json({ conversations });
    }
    case "deleteConversation": {
      if (!b.id) return NextResponse.json({ error: "id required." }, { status: 400 });
      const existing = await getConversation(b.id);
      if (!existing) {
        return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
      }
      if (existing.kind === "legacy") {
        return NextResponse.json({ error: "The Old thread can't be deleted." }, { status: 400 });
      }
      await deleteConversation(b.id);
      const conversations = sortForSwitcher(await listConversations(existing.projectId));
      return NextResponse.json({ conversations });
    }
    default:
      return NextResponse.json({ error: "Unknown op." }, { status: 400 });
  }
}
