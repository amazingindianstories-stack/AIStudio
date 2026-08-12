import { NextResponse } from "next/server";
import { getConversation, attachGeneratedItem } from "@/lib/agent-conversations-db";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";

/** PATCH /api/agent-conversations/[id]/messages/[messageId] { generatedItemId }
 *  -> { message }. Called client-side right after s.generate() actually
 *  creates a row, so a later reload can tell a finished generation from one
 *  still running — see StudioChat.tsx and attachGeneratedItem's doc comment. */
export async function PATCH(
  req,
  { params }
) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  const { id, messageId } = await params;
  const conversation = await getConversation(id);
  if (!conversation) {
    return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  }

  const b = await req.json().catch(() => ({}));
  const generatedItemId = typeof b.generatedItemId === "string" ? b.generatedItemId.trim() : "";
  if (!generatedItemId) {
    return NextResponse.json({ error: "generatedItemId is required." }, { status: 400 });
  }

  const message = await attachGeneratedItem(messageId, generatedItemId);
  if (!message) {
    return NextResponse.json({ error: "Message not found." }, { status: 404 });
  }
  return NextResponse.json({ message });
}
