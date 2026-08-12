import type { AgentMessage } from "../types";
import { callGeminiRaw, type GeminiPart } from "../llm-provider";
import { systemPromptForKind } from "./prompts";
import { toolsForKind, dispatchTool } from "./tools";
import type { AgentKind } from "./types";

const MAX_TOOL_ROUNDS = 4;

export interface OrchestratorResult {
  reply: string;
  toolTrace?: { tool: string; args: unknown; result: unknown };
}

function historyToContents(
  history: AgentMessage[]
): { role: "user" | "model"; parts: GeminiPart[] }[] {
  return history
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? ("model" as const) : ("user" as const),
      parts: [{ text: m.content }],
    }));
}

/**
 * The agentic tool-calling loop: call Gemini with `tools`, and when it
 * returns a functionCall part, dispatch it locally and feed the result back
 * as a functionResponse part, repeating until a final text reply arrives.
 *
 * Turn shape for the functionResponse round (role: "user" carrying a
 * functionResponse part, not a separate "function" role) follows Gemini's
 * REST API examples — verify against scripts/probe-agent-tools.ts before
 * trusting this in production, same as every other provider contract in this
 * repo that isn't from an official SDK.
 */
export async function runOrchestratorTurn(
  history: AgentMessage[],
  newMessage: string,
  images: GeminiPart[] = [],
  kind: AgentKind = "image"
): Promise<OrchestratorResult> {
  const contents = historyToContents(history);
  contents.push({ role: "user", parts: [{ text: newMessage }, ...images] });

  let lastTrace: { tool: string; args: unknown; result: unknown } | undefined;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const { parts, finishReason } = await callGeminiRaw({
      systemPrompt: systemPromptForKind(kind),
      contents,
      tools: toolsForKind(kind),
    });

    const functionCallPart = parts.find((p) => p.functionCall);
    if (functionCallPart?.functionCall) {
      const { name, args } = functionCallPart.functionCall;
      // Echo the part back VERBATIM, not a {name, args} reconstruction — a
      // thinking-enabled model attaches a thoughtSignature alongside
      // functionCall (sibling field, outside our GeminiPart type but present
      // on the real JSON), and Gemini 400s the next round ("Function call is
      // missing a thought_signature in functionCall parts") if it's dropped.
      contents.push({ role: "model", parts: [functionCallPart] });

      // Dispatch failures (unknown tool, subagent error) are fed back to the
      // model as an error result rather than aborting the whole turn — lets
      // it apologize/recover instead of a hard 502 on something recoverable.
      let response: Record<string, unknown>;
      try {
        const dispatched = await dispatchTool(name, args, images);
        response = dispatched.response;
        lastTrace = dispatched.trace;
      } catch (err) {
        response = { error: err instanceof Error ? err.message : "Tool failed." };
      }
      contents.push({ role: "user", parts: [{ functionResponse: { name, response } }] });
      continue;
    }

    const textPart = parts.find((p) => typeof p.text === "string");
    if (textPart?.text) {
      return { reply: textPart.text, toolTrace: lastTrace };
    }

    throw new Error(`Orchestrator returned nothing usable (${finishReason || "no candidates"}).`);
  }

  throw new Error("Orchestrator exceeded the tool-call round limit without a final reply.");
}
