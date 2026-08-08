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
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_API_KEY is not set.");

  // Gemini's generateContent has no "system"/"assistant" role — system
  // instructions are a separate field, and its assistant role is "model".
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents,
  };

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
  const part = (json?.candidates?.[0]?.content?.parts ?? []).find(
    (p: { text?: string }) => typeof p?.text === "string"
  );
  if (!part) {
    const reason = json?.candidates?.[0]?.finishReason || "no candidates";
    throw new Error(`Agent LLM returned no text (${reason}).`);
  }

  const usageMeta = json?.usageMetadata;
  return {
    text: part.text,
    usage: usageMeta
      ? {
          tokensIn: usageMeta.promptTokenCount,
          tokensOut: usageMeta.candidatesTokenCount,
        }
      : undefined,
  };
}
