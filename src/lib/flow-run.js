import { create } from "zustand";
import { useCanvasStore } from "./canvas-store";
import { flowSteps, nodeText, planRun, newStep, templateGraph } from "./canvas/flows";
import * as api from "./sidekick-api";
import { useSidekick } from "./sidekick";

// Running a Flow. The run is quoted first (every step that would run, with a total), then started by an explicit
// click; each step is one paid text job, run in order so a step's output is the next one's input. A step whose
// task and inputs are unchanged since its last run is skipped, so a re-run only pays for what changed. The output
// a step is about to replace is kept on the server for 24 hours, and Revert puts one back.

export const useFlowRun = create((set, get) => ({
  quote: null,
  running: null, // { total, done, current } while a run is in progress
  error: null,
  results: {}, // stepId -> "done" | "skipped" | "failed"
  cancelled: false,

  /** The price of running `stepIds` now: the steps that are stale, quoted together. */
  estimate: async (stepIds, options = {}) => {
    const boardId = useSidekick.getState().boardId;
    const plan = planRun(useCanvasStore.getState().history.present, stepIds, options);
    const todo = plan.steps.filter((step) => !step.skip);
    if (!boardId || !todo.length) return set({ quote: { costCents: 0, steps: [], skipped: plan.steps.length, cyclic: plan.cyclic } });
    try {
      const quote = await api.quoteFlow(boardId, todo.map((step) => step.body));
      set({ quote: { ...quote, skipped: plan.steps.length - todo.length, cyclic: plan.cyclic }, error: null });
    } catch (error) {
      set({ quote: null, error: error.message });
    }
  },

  cancel: () => set({ cancelled: true }),

  run: async (stepIds, options = {}) => {
    const boardId = useSidekick.getState().boardId;
    if (!boardId || get().running) return;
    set({ running: { total: stepIds.length, done: 0, current: null }, error: null, results: {}, cancelled: false, quote: null });
    const outputs = {};
    const results = {};
    let current = null;
    try {
      for (let i = 0; i < stepIds.length; i += 1) {
        // Re-plan with the outputs so far: a step whose upstream changed must run even if its old hash matched.
        const plan = planRun(useCanvasStore.getState().history.present, stepIds, { ...options, outputs });
        const step = plan.steps.find((item) => !results[item.id]);
        if (!step || get().cancelled) break;
        if (step.skip) {
          results[step.id] = "skipped";
        } else {
          current = step.id;
          set({ running: { total: stepIds.length, done: Object.keys(results).length, current } });
          const text = await runStep(boardId, step);
          outputs[step.id] = text;
          results[step.id] = "done";
          current = null;
        }
        set({ results: { ...results }, running: { total: stepIds.length, done: Object.keys(results).length, current: null } });
      }
    } catch (error) {
      if (current) results[current] = "failed";
      set({ error: error.message });
      if (error.code === "AI_CREDITS_EXHAUSTED") void useSidekick.getState().loadCredits();
    } finally {
      set({ running: null, results: { ...results } });
      void useSidekick.getState().loadCredits();
    }
  },
}));

async function runStep(boardId, step) {
  const job = await api.submitStep(boardId, step.body, crypto.randomUUID());
  const done = await api.waitForJob(boardId, job.id);
  if (done.status !== "succeeded") throw new Error(done.error || "A Flow step did not finish.");
  const text = done.result?.text ?? "";
  writeOutput(boardId, step.id, text, step.hash);
  return text;
}

/** Put `text` in the step's sticky, keeping the text it replaces as a version. One undo step. */
export function writeOutput(boardId, nodeId, text, hash) {
  const canvas = useCanvasStore.getState();
  const before = canvas.history.present.nodes.find((n) => n.id === nodeId);
  if (!before) return;
  const previous = nodeText(before);
  if (previous.trim()) api.recordVersion(boardId, nodeId, previous).catch(() => {});
  canvas.editBoard((present) => ({
    ...present,
    nodes: present.nodes.map((n) => {
      if (n.id !== nodeId) return n;
      const next = { ...n, text, aiEditedAt: Date.now() };
      delete next.marks;
      if (hash) next.flow = { ...n.flow, inputHash: hash };
      return next;
    }),
  }));
}

/** Revert a step's output to an earlier version (the hash is cleared, so the step reads as needing a run). */
export function revertOutput(boardId, nodeId, text) {
  const canvas = useCanvasStore.getState();
  const before = canvas.history.present.nodes.find((n) => n.id === nodeId);
  if (!before) return;
  const previous = nodeText(before);
  if (previous.trim() && previous !== text) api.recordVersion(boardId, nodeId, previous).catch(() => {});
  canvas.editBoard((present) => ({
    ...present,
    nodes: present.nodes.map((n) => {
      if (n.id !== nodeId) return n;
      const flow = { ...n.flow };
      delete flow.inputHash;
      const next = { ...n, text, flow, aiEditedAt: Date.now() };
      delete next.marks;
      return next;
    }),
  }));
}

/** Place a new step next to the selection or at the view centre; arrows from the selected objects feed it. */
export function addStep(task) {
  const canvas = useCanvasStore.getState();
  const state = canvas.history.present;
  const sources = state.nodes.filter((n) => canvas.selection.includes(n.id));
  const center = canvas.viewportCenter();
  const right = sources.length ? Math.max(...sources.map((n) => n.x + n.w)) + 120 : center.x - 120;
  const top = sources.length ? Math.min(...sources.map((n) => n.y)) : center.y - 100;
  const step = newStep({ task, x: right, y: top });
  canvas.editBoard((present) => ({
    ...present,
    nodes: [...present.nodes, step],
    connectors: [...present.connectors, ...sources.map((n) => ({ id: crypto.randomUUID(), from: { nodeId: n.id, anchor: "auto" }, to: { nodeId: step.id, anchor: "auto" }, kind: "arrow", stroke: "#000000", strokeWidth: 2 }))],
  }));
  return step.id;
}

export function addTemplate(template) {
  const canvas = useCanvasStore.getState();
  const center = canvas.viewportCenter();
  const graph = templateGraph(template, { x: center.x - 300, y: center.y - 100 });
  canvas.editBoard((present) => ({ ...present, nodes: [...present.nodes, ...graph.nodes], connectors: [...present.connectors, ...graph.connectors] }));
  return graph.nodes.map((n) => n.id);
}

/** Change a step's instruction (clears the hash so the step is stale). */
export function editStep(nodeId, patch) {
  useCanvasStore.getState().editBoard((present) => ({
    ...present,
    nodes: present.nodes.map((n) => {
      if (n.id !== nodeId || !n.flow) return n;
      const flow = { ...n.flow, ...patch };
      delete flow.inputHash;
      return { ...n, flow };
    }),
  }));
}

export { flowSteps };
