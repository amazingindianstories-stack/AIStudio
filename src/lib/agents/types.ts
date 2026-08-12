export type AgentRole = "image" | "video" | "story";

export interface AgentMessage {
  role: "user" | "system" | "assistant";
  content: string;
}

export interface AgentRequest {
  role: AgentRole;
  userId?: string;
  messages: AgentMessage[];
  /** e.g. current composer prompt/model/aspectRatio, or the active board name. */
  context?: Record<string, unknown>;
}

export interface AgentResponse {
  messages: { role: "assistant"; content: string }[];
  usage?: { tokensIn?: number; tokensOut?: number };
  error?: string;
}

export interface Agent {
  run(request: AgentRequest): Promise<AgentResponse>;
}
