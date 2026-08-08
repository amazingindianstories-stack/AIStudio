/**
 * Text-chat LLM call for the agent layer. Reuses GOOGLE_API_KEY and the same
 * generativelanguage REST endpoint as providers/gemini.ts and providers/omni.ts
 * (direct fetch, no SDK — matches every other provider in this codebase)
 * rather than adding a new provider/credential for chat.
 *
 * Model defaults to Google's "gemini-flash-latest" alias, which tracks
 * whatever Google currently serves under that name — avoids hardcoding a
 * specific dated model id this session can't verify. Override with
 * AGENT_LLM_MODEL. Verify the contract with scripts/probe-agent-llm.ts before
 * relying on this in production, same convention as this repo's other probes.
 */
import type { AgentMessage } from "./types";

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-flash-latest";

export function agentModel(): string {
  return process.env.AGENT_LLM_MODEL || DEFAULT_MODEL;
}

export interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

export interface GeminiToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface CallGeminiRawInput {
  model?: string;
  systemPrompt: string;
  contents: { role: "user" | "model"; parts: GeminiPart[] }[];
  tools?: GeminiToolDeclaration[];
}

export interface CallGeminiRawResult {
  parts: GeminiPart[];
  finishReason?: string;
  usage?: { tokensIn?: number; tokensOut?: number };
}

/** Low-level call used directly by the tool-calling orchestrator (which needs
 *  to send/receive functionCall/functionResponse parts, not just text turns —
 *  see orchestrator/orchestrator.ts). callLLM below is the simple text-only
 *  wrapper the three scoped agents (image/video/story) use. */
export async function callGeminiRaw({
  model,
  systemPrompt,
  contents,
  tools,
}: CallGeminiRawInput): Promise<CallGeminiRawResult> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_API_KEY is not set.");

  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents,
  };
  if (tools && tools.length > 0) {
    body.tools = [{ functionDeclarations: tools }];
  }

  const res = await fetch(`${API_ROOT}/models/${model || agentModel()}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Agent LLM error (${res.status}): ${errText.slice(0, 400)}`);
  }

  const json = await res.json();
  const candidate = json?.candidates?.[0];
  const usageMeta = json?.usageMetadata;
  return {
    parts: candidate?.content?.parts ?? [],
    finishReason: candidate?.finishReason,
    usage: usageMeta
      ? { tokensIn: usageMeta.promptTokenCount, tokensOut: usageMeta.candidatesTokenCount }
      : undefined,
  };
}

export interface CallLLMInput {
  model?: string;
  systemPrompt: string;
  messages: AgentMessage[];
}

export interface CallLLMResult {
  text: string;
  usage?: { tokensIn?: number; tokensOut?: number };
}

export async function callLLM({
  model,
  systemPrompt,
  messages,
}: CallLLMInput): Promise<CallLLMResult> {
  // Gemini's generateContent has no "system"/"assistant" role — system
  // instructions are a separate field, and its assistant role is "model".
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? ("model" as const) : ("user" as const),
      parts: [{ text: m.content }],
    }));

  const { parts, finishReason, usage } = await callGeminiRaw({ model, systemPrompt, contents });
  const part = parts.find((p) => typeof p.text === "string");
  if (!part) {
    throw new Error(`Agent LLM returned no text (${finishReason || "no candidates"}).`);
  }
  return { text: part.text!, usage };
}
