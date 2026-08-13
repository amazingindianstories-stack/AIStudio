

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-flash-latest";

export function agentModel() {
  return process.env.AGENT_LLM_MODEL || DEFAULT_MODEL;
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
}) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_API_KEY is not set.");

  const body = {
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

export async function callLLM({
  model,
  systemPrompt,
  messages,
}) {
  // Gemini's generateContent has no "system"/"assistant" role — system
  // instructions are a separate field, and its assistant role is "model".
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? ("model" ) : ("user" ),
      parts: [{ text: m.content }],
    }));

  const { parts, finishReason, usage } = await callGeminiRaw({ model, systemPrompt, contents });
  const part = parts.find((p) => typeof p.text === "string");
  if (!part) {
    throw new Error(`Agent LLM returned no text (${finishReason || "no candidates"}).`);
  }
  return { text: part.text, usage };
}
