import { NextResponse } from "next/server";
import { getConversation, listMessages } from "@/lib/agent-conversations-db";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";

/** GET /api/agent-conversations/[id] -> { conversation, messages }. */
export async function GET(
  _req,
  { params }
) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  const { id } = await params;
  const conversation = await getConversation(id);
  if (!conversation) {
    return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  }
  const messages = await listMessages(id);
  return NextResponse.json({ conversation, messages });
}
