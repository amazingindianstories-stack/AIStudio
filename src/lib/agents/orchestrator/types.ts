/**
 * Pure types shared between agent-conversations-db.ts (server) and the
 * frontend chat components — no runtime imports (crypto/drizzle) here, same
 * reasoning as canvas/types.ts vs canvas-db.ts, so client components can
 * import these safely.
 */
export type AgentKind = "image" | "video";

export interface AgentConversationMeta {
  id: string;
  projectId: string;
  name: string;
  agentKind: AgentKind;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AgentConversationMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  toolTrace: { tool: string; args: unknown; result: unknown } | null;
  createdAt: number;
}
