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

export interface AgentConversationToolTrace {
  tool: string;
  args: unknown;
  result: unknown;
  // Set after the fact, once the client's s.generate() call (fired client-
  // side after this message was already persisted — see orchestrator.ts's
  // header) actually creates a GenerationItem. Without this, a reload has no
  // way to know a generate_{image,video}/design_prompt message already
  // finished — see StudioChat.tsx.
  generatedItemId?: string;
}

export interface AgentConversationMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  toolTrace: AgentConversationToolTrace | null;
  createdAt: number;
}
