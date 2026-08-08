import { NextRequest, NextResponse } from "next/server";
import { getConversation, listMessages } from "@/lib/agent-conversations-db";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";

/** GET /api/agent-conversations/[id] -> { conversation, messages }.
 *  A legacy thread's `messages` is always [] — its content is the existing
 *  generation feed, read from /api/history exactly as ConversationPanel
 *  already does; this route doesn't duplicate that. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  const { id } = await params;
  const conversation = await getConversation(id);
  if (!conversation) {
    return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  }
  const messages = conversation.kind === "legacy" ? [] : await listMessages(id);
  return NextResponse.json({ conversation, messages });
}
