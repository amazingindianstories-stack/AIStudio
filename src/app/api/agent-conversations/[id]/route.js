import { NextResponse } from "next/server";
import { getConversation, listMessages } from "@/lib/agent-conversations-db";
import { adminOrNull } from "@/lib/admin";

export const runtime = "nodejs";

/** GET /api/agent-conversations/[id] -> { conversation, messages }. Admin-only. */
export async function GET(
  _req,
  { params }
) {
  if (!(await adminOrNull())) {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }
  const { id } = await params;
  const conversation = await getConversation(id);
  if (!conversation) {
    return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  }
  const messages = await listMessages(id);
  return NextResponse.json({ conversation, messages });
}
