import { NextResponse } from "next/server";
import { getConversation, listMessages, appendMessage } from "@/lib/agent-conversations-db";
import { getSession } from "@/lib/auth";
import { runOrchestratorTurn } from "@/lib/agents/orchestrator/orchestrator";
import { imagesToParts } from "@/lib/agents/orchestrator/images";
import { parseMessageBody } from "@/lib/agents/orchestrator/validate-message";

export const runtime = "nodejs";
export const maxDuration = 60; // a tool-calling turn is at most 2 sequential Gemini round trips

/** POST /api/agent-conversations/[id]/messages { content, images? }
 *  -> { userMessage, assistantMessage }. Persists the user turn, runs the
 *  orchestrator's tool-calling loop, persists the reply, returns both. */
export async function POST(
  req,
  { params }
) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  const { id } = await params;
  const conversation = await getConversation(id);
  if (!conversation) {
    return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  }

  const b = await req.json().catch(() => ({}));
  const parsed = parseMessageBody(b);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  const { content, images: imageDataUrls } = parsed;

  let imageParts;
  try {
    imageParts = imagesToParts(imageDataUrls);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid reference image.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const priorMessages = await listMessages(id);
  const history = priorMessages.map((m) => ({ role: m.role, content: m.content }));

  const userMessage = await appendMessage(id, "user", content);

  try {
    const { reply, toolTrace } = await runOrchestratorTurn(
      history,
      content,
      imageParts,
      conversation.agentKind
    );
    const assistantMessage = await appendMessage(id, "assistant", reply, toolTrace ?? null);
    return NextResponse.json({ userMessage, assistantMessage });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Orchestrator request failed.";
    console.error(`[agent-conversations/${id}/messages]`, message);
    // The user's turn is already persisted (it happened) — only the reply
    // failed, so the client can show an inline error without losing input.
    return NextResponse.json({ userMessage, error: message }, { status: 502 });
  }
}
