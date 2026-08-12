import { NextRequest, NextResponse } from "next/server";
import {
  listConversations,
  createConversation,
  renameConversation,
  deleteConversation,
  getConversation,
} from "@/lib/agent-conversations-db";
import { adminOrNull } from "@/lib/admin";
import type { AgentKind } from "@/lib/agents/orchestrator/types";

export const runtime = "nodejs";

function parseAgentKind(value: unknown): AgentKind | null {
  return value === "image" || value === "video" ? value : null;
}

/** Newest-first. */
function sortForSwitcher<T extends { updatedAt: number }>(list: T[]): T[] {
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** GET /api/agent-conversations?projectId=<uuid>&agentKind=image|video
 *  -> { conversations }. Admin-only while the Agents tab is gated in the UI —
 *  the lock on the nav tab is cosmetic, this is the actual access control. */
export async function GET(req: NextRequest) {
  if (!(await adminOrNull())) {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }
  const projectId = req.nextUrl.searchParams.get("projectId");
  const agentKind = parseAgentKind(req.nextUrl.searchParams.get("agentKind"));
  if (!projectId) {
    return NextResponse.json({ error: "projectId required." }, { status: 400 });
  }
  if (!agentKind) {
    return NextResponse.json({ error: "agentKind must be 'image' or 'video'." }, { status: 400 });
  }
  const conversations = sortForSwitcher(await listConversations(projectId, agentKind));
  return NextResponse.json({ conversations });
}

/** Single mutation endpoint, switched on `op` — mirrors
 *  api/canvas-boards/route.ts's createBoard/renameBoard/deleteBoard shape. */
export async function POST(req: NextRequest) {
  const user = await adminOrNull();
  if (!user) {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }
  const b = await req.json().catch(() => ({}));
  const op: string = b.op;

  switch (op) {
    case "createConversation": {
      const name = (b.name || "").trim();
      const projectId = b.projectId;
      const agentKind = parseAgentKind(b.agentKind);
      if (!projectId) {
        return NextResponse.json({ error: "projectId required." }, { status: 400 });
      }
      if (!agentKind) {
        return NextResponse.json({ error: "agentKind must be 'image' or 'video'." }, { status: 400 });
      }
      if (!name) {
        return NextResponse.json({ error: "Name required." }, { status: 400 });
      }
      const conversation = await createConversation(projectId, agentKind, name, user.id);
      const conversations = sortForSwitcher(await listConversations(projectId, agentKind));
      return NextResponse.json({ conversations, conversation });
    }
    case "renameConversation": {
      if (!b.id) return NextResponse.json({ error: "id required." }, { status: 400 });
      const existing = await getConversation(b.id);
      if (!existing) {
        return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
      }
      await renameConversation(b.id, (b.name || "").trim());
      const conversations = sortForSwitcher(
        await listConversations(existing.projectId, existing.agentKind)
      );
      return NextResponse.json({ conversations });
    }
    case "deleteConversation": {
      if (!b.id) return NextResponse.json({ error: "id required." }, { status: 400 });
      const existing = await getConversation(b.id);
      if (!existing) {
        return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
      }
      await deleteConversation(b.id);
      const conversations = sortForSwitcher(
        await listConversations(existing.projectId, existing.agentKind)
      );
      return NextResponse.json({ conversations });
    }
    default:
      return NextResponse.json({ error: "Unknown op." }, { status: 400 });
  }
}
