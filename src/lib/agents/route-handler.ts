import { NextRequest, NextResponse } from "next/server";
import { getSession } from "../auth";
import { getAgent } from "./registry";
import type { AgentMessage, AgentRole } from "./types";

const MAX_MESSAGES = 40;
const MAX_MESSAGE_LEN = 8000;

export function parseMessages(raw: unknown): AgentMessage[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MESSAGES) return null;
  const messages: AgentMessage[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") return null;
    const role = (m as { role?: unknown }).role;
    const content = (m as { content?: unknown }).content;
    if (role !== "user" && role !== "system" && role !== "assistant") return null;
    if (typeof content !== "string" || !content.trim()) return null;
    messages.push({ role, content: content.slice(0, MAX_MESSAGE_LEN) });
  }
  return messages;
}

/** Shared body of /api/agents/{image,video,story} — auth, validation,
 *  calling the agent, normalizing the response. Kept in one place so the
 *  three route files stay thin rather than triplicating this logic. */
export async function handleAgentRequest(
  role: AgentRole,
  req: NextRequest
): Promise<NextResponse> {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const messages = parseMessages(body?.messages);
  if (!messages) {
    return NextResponse.json(
      { error: "messages must be a non-empty array of { role, content }." },
      { status: 400 }
    );
  }
  const context =
    body?.context && typeof body.context === "object" ? body.context : undefined;

  try {
    const agent = getAgent(role);
    const result = await agent.run({ role, userId: user.id, messages, context });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Agent request failed.";
    console.error(`[agents/${role}]`, message);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
