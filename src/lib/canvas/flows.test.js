import assert from "node:assert/strict";
import test from "node:test";
import { downstreamOf, inputHash, inputIds, newStep, planRun, runOrder, stepInputs, templateGraph } from "./flows.js";
import { validateCanvasState } from "./serialization.js";

const note = (id, text) => ({ id, type: "sticky", x: 0, y: 0, w: 200, h: 200, text, fill: "#e3c56a", fontSize: 16, color: "#1c1a12", opacity: 1, parentId: null, groupId: null });
const arrow = (from, to) => ({ id: `${from}-${to}`, from: { nodeId: from, anchor: "auto" }, to: { nodeId: to, anchor: "auto" }, kind: "arrow", stroke: "#000", strokeWidth: 2 });
const state = (nodes, connectors) => ({ version: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes, connectors });

function chain() {
  const s1 = newStep({ id: "s1", task: "Summarize" });
  const s2 = newStep({ id: "s2", task: "List actions" });
  return state([note("a", "alpha"), note("b", "beta"), s1, s2], [arrow("a", "s1"), arrow("b", "s1"), arrow("s1", "s2")]);
}

test("inputs come from arrows into the step, in order, without repeats", () => {
  const s = chain();
  s.connectors.push(arrow("a", "s1"));
  assert.deepEqual(inputIds(s, "s1"), ["a", "b"]);
  assert.deepEqual(stepInputs(s, "s1"), [{ text: "alpha" }, { text: "beta" }]);
  assert.deepEqual(stepInputs(s, "s2", { s1: "fresh" }), [{ text: "fresh" }]);
});

test("steps run inputs first and a cycle is reported instead of looping", () => {
  assert.deepEqual(runOrder(chain(), ["s2", "s1"]).order, ["s1", "s2"]);
  const loop = state([newStep({ id: "x", task: "t" }), newStep({ id: "y", task: "t" })], [arrow("x", "y"), arrow("y", "x")]);
  assert.deepEqual(runOrder(loop, ["x", "y"]), { order: [], cyclic: ["x", "y"] });
  assert.deepEqual(downstreamOf(chain(), "s1"), ["s2"]);
});

test("a current step is skipped unless an input changed or the run is forced", () => {
  const s = chain();
  const first = planRun(s, ["s1", "s2"]);
  assert.deepEqual(first.steps.map((p) => p.skip), [false, false]);
  const ran = state(s.nodes.map((n) => (n.id === "s1" || n.id === "s2" ? { ...n, text: "out", flow: { ...n.flow, inputHash: first.steps.find((p) => p.id === n.id).hash } } : n)), s.connectors);
  // s2's hash was computed while s1 was empty, so record what it would send once s1 holds "out".
  const second = planRun(ran, ["s1", "s2"]);
  assert.equal(second.steps[0].skip, true);
  assert.equal(second.steps[1].skip, false);
  assert.equal(planRun(ran, ["s1", "s2"], { force: true }).steps.every((p) => !p.skip), true);
  const edited = state(ran.nodes.map((n) => (n.id === "a" ? { ...n, text: "changed" } : n)), ran.connectors);
  assert.deepEqual(planRun(edited, ["s1", "s2"]).steps.map((p) => p.skip), [false, false]);
});

test("the hash depends on task, web search and every input", () => {
  const base = inputHash("t", false, [{ text: "a" }]);
  assert.notEqual(base, inputHash("u", false, [{ text: "a" }]));
  assert.notEqual(base, inputHash("t", true, [{ text: "a" }]));
  assert.notEqual(base, inputHash("t", false, [{ text: "a" }, { text: "" }]));
  assert.equal(base, inputHash("t", false, [{ text: "a" }]));
  assert.equal(base.length, 16);
});

test("a template becomes chained steps the server keeps whole", () => {
  const graph = templateGraph({ steps: [{ task: "One", webSearch: true }, { task: "Two" }] }, { x: 10, y: 20 });
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.connectors.length, 1);
  const parsed = validateCanvasState(state(graph.nodes, graph.connectors));
  assert.deepEqual(parsed.nodes.map((n) => n.flow), [{ block: "instruction", task: "One", webSearch: true }, { block: "instruction", task: "Two" }]);
  assert.equal(parsed.nodes[0].aiCreated, true);
});
