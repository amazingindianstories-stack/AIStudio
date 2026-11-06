import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_MODELS, DEFAULT_AGENT_MODEL, DEFAULT_AGENT_THINKING, agentModelLabel, agentThinkingFor, thinkingLevelsFor,
} from "./agent-model";
import { restoreComposerDraft, useStore } from "./store";
import { runState, runView } from "./agent-run";

test("the chat offers the latest Flash and 3.1 Pro, each at low, medium or high thinking, Flash at medium by default", () => {
  // The same pairs the agent loop accepts (backend/apps/agents/loop_llm.py THINKING_LEVELS, tested in test_loop_llm.py).
  assert.deepEqual(AGENT_MODELS.map((m) => [m.id, m.label]), [["gemini-3.8-flash", "Gemini 3.8 Flash"], ["gemini-3.1-pro-preview", "Gemini 3.1 Pro"]]);
  for (const m of AGENT_MODELS) assert.deepEqual(thinkingLevelsFor(m.id), ["LOW", "MEDIUM", "HIGH"]);
  assert.equal(DEFAULT_AGENT_MODEL, "gemini-3.8-flash");
  assert.equal(DEFAULT_AGENT_THINKING, "MEDIUM");
  assert.deepEqual(thinkingLevelsFor("gemini-2.5-pro"), []);
});

test("a level the model does not take falls back to medium, and the trace names the model and level", () => {
  assert.equal(agentThinkingFor("gemini-3.1-pro-preview", "HIGH"), "HIGH");
  for (const level of ["MINIMAL", "high", "", null, undefined]) assert.equal(agentThinkingFor("gemini-3.8-flash", level), "MEDIUM");
  assert.equal(agentThinkingFor("gemini-2.5-pro", "LOW"), "MEDIUM");
  assert.equal(agentModelLabel("gemini-3.1-pro-preview", "HIGH"), "Gemini 3.1 Pro, high thinking");
  assert.equal(agentModelLabel("gemini-3.8-flash", "LOW"), "Gemini 3.8 Flash, low thinking");
  // A run from before thinking levels reads as its model alone; an unknown id reads as sent.
  assert.equal(agentModelLabel("gemini-3.8-flash", null), "Gemini 3.8 Flash");
  assert.equal(agentModelLabel("gemini-9-ultra", "MEDIUM"), "gemini-9-ultra, medium thinking");
  assert.equal(agentModelLabel(null, "HIGH"), null);
});

function withStorage(run) {
  const previous = useStore.getState();
  const previousStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  try {
    run(values);
  } finally {
    globalThis.localStorage = previousStorage;
    useStore.setState(previous, true);
  }
}

test("the store keeps a model and level pair the agent accepts", () => withStorage(() => {
  const s = () => useStore.getState();
  assert.equal(s().agentModel, "gemini-3.8-flash");
  assert.equal(s().agentThinking, "MEDIUM");
  s().setAgentThinking("HIGH");
  s().setAgentModel("gemini-3.1-pro-preview");
  assert.deepEqual([s().agentModel, s().agentThinking], ["gemini-3.1-pro-preview", "HIGH"]);
  s().setAgentThinking("MINIMAL");
  assert.equal(s().agentThinking, "MEDIUM");
  s().setAgentModel("gemini-2.5-pro");
  assert.equal(s().agentModel, "gemini-3.8-flash");
}));

test("the local draft restores the agent model and level, and drops a pair the agent would refuse", () => withStorage((values) => {
  const restore = (settings) => {
    useStore.setState({ agentModel: "gemini-3.8-flash", agentThinking: "MEDIUM" });
    values.set("veevee-draft-settings-v1", JSON.stringify(settings));
    restoreComposerDraft();
    return [useStore.getState().agentModel, useStore.getState().agentThinking];
  };
  assert.deepEqual(restore({ agentModel: "gemini-3.1-pro-preview", agentThinking: "LOW" }), ["gemini-3.1-pro-preview", "LOW"]);
  assert.deepEqual(restore({ agentModel: "gemini-2.5-pro", agentThinking: "HIGH" }), ["gemini-3.8-flash", "HIGH"]);
  assert.deepEqual(restore({ agentModel: "gemini-3.1-pro-preview", agentThinking: "MINIMAL" }), ["gemini-3.1-pro-preview", "MEDIUM"]);
  // A draft saved before the agent model control restores the defaults.
  assert.deepEqual(restore({ mode: "image" }), ["gemini-3.8-flash", "MEDIUM"]);
}));

test("a run's view carries its thinking level next to its model", () => {
  const view = runView(runState({ id: "run-1", status: "running", model: "gemini-3.1-pro-preview", thinkingLevel: "HIGH" }));
  assert.equal(view.model, "gemini-3.1-pro-preview");
  assert.equal(view.thinkingLevel, "HIGH");
  assert.equal(runView(runState({ id: "run-2", status: "running", model: "gemini-3.8-flash" })).thinkingLevel, null);
});
