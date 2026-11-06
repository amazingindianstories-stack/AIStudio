/**
 * The Agents chat's LLM choice: the model a run reasons with and its thinking level, sent with each message as
 * `model` and `thinkingLevel`. The ids and levels mirror backend/apps/agents/loop_llm.py (LOOP_MODELS and
 * THINKING_LEVELS), which rejects any other pair.
 *
 *   const level = agentThinkingFor(model, s.agentThinking);
 */

export const DEFAULT_AGENT_MODEL = "gemini-3.8-flash";
export const DEFAULT_AGENT_THINKING = "MEDIUM";

export const AGENT_MODELS = [
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", short: "Flash", hint: "Fast and low cost", levels: ["LOW", "MEDIUM", "HIGH"] },
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", short: "3.1 Pro", hint: "Stronger reasoning, slower, costs more", levels: ["LOW", "MEDIUM", "HIGH"] },
];

export const THINKING_LABELS = { LOW: "Low", MEDIUM: "Medium", HIGH: "High" };

export function agentModel(id) {
  return AGENT_MODELS.find((m) => m.id === id) || null;
}

/** The thinking levels ``model`` takes, or none for a model the chat does not offer. */
export function thinkingLevelsFor(model) {
  return agentModel(model)?.levels ?? [];
}

/** ``level`` when ``model`` takes it, else the default level. */
export function agentThinkingFor(model, level) {
  return thinkingLevelsFor(model).includes(level) ? level : DEFAULT_AGENT_THINKING;
}

/** How the trace names a run's model and level, e.g. "Gemini 3.1 Pro, high thinking"; unknown ids read as sent. */
export function agentModelLabel(model, level) {
  if (!model) return null;
  const name = agentModel(model)?.label ?? model;
  return THINKING_LABELS[level] ? `${name}, ${THINKING_LABELS[level].toLowerCase()} thinking` : name;
}
