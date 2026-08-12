
import { systemPromptFor } from "./prompts";
import { callLLM } from "./llm-provider";

const MAX_CONTEXT_VALUE_LEN = 4000;

/** Folds AgentRequest.context into the system prompt as a short labeled
 *  block — Gemini's generateContent has no dedicated "context" slot, and this
 *  keeps the raw chat turns (messages) as just the conversation. */
function withContext(systemPrompt, context) {
  if (!context || Object.keys(context).length === 0) return systemPrompt;
  const lines = Object.entries(context)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => {
      const value = typeof v === "string" ? v : JSON.stringify(v);
      return `- ${k}: ${value.slice(0, MAX_CONTEXT_VALUE_LEN)}`;
    });
  if (lines.length === 0) return systemPrompt;
  return `${systemPrompt}\n\nCurrent context:\n${lines.join("\n")}`;
}

export function createChatAgent(role) {
  return {
    async run(request) {
      const systemPrompt = withContext(systemPromptFor(role), request.context);
      const { text, usage } = await callLLM({
        systemPrompt,
        messages: request.messages,
      });
      return { messages: [{ role: "assistant", content: text }], usage };
    },
  };
}
