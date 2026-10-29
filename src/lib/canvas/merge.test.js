import assert from "node:assert/strict";
import test from "node:test";
import { mergeCanvasStates, rebaseHistory, sameValue } from "./merge.js";
import { commit, undo } from "./history.js";
import { emptyCanvasState } from "./serialization.js";

const rect = (id, extra = {}) => ({ id, type: "rect", x: 0, y: 0, w: 10, h: 10, parentId: null, groupId: null, fill: "#fff", stroke: "#000", strokeWidth: 1, ...extra });
const graph = (nodes, connectors = [], viewport = { x: 0, y: 0, zoom: 1 }) => ({ ...emptyCanvasState(), viewport, nodes, connectors });
const ids = (state) => state.nodes.map((node) => node.id);
const node = (state, id) => state.nodes.find((item) => item.id === id);
const arrow = (id, from, to) => ({ id, from: { nodeId: from, anchor: "auto" }, to: { nodeId: to, anchor: "auto" }, kind: "arrow", stroke: "#fff", strokeWidth: 2 });

test("edits on one side win, and the same node edited on both sides keeps the local edit", () => {
  const base = graph([rect("a"), rect("b"), rect("c")]);
  const local = graph([rect("a", { x: 5 }), rect("b"), rect("c", { fill: "#111" })]);
  const remote = graph([rect("a"), rect("b", { y: 7 }), rect("c", { fill: "#222", x: 9 })]);
  const merged = mergeCanvasStates(base, local, remote);
  assert.equal(node(merged, "a").x, 5);
  assert.equal(node(merged, "b").y, 7);
  assert.deepEqual(node(merged, "c"), rect("c", { fill: "#111" }));
});

test("deletions: a local delete beats a remote edit, a local edit survives a remote delete", () => {
  const base = graph([rect("a"), rect("b"), rect("c"), rect("d")]);
  const local = graph([rect("b", { x: 1 }), rect("c"), rect("d")]);
  const remote = graph([rect("a", { x: 3 }), rect("d")]);
  const merged = mergeCanvasStates(base, local, remote);
  assert.deepEqual(ids(merged), ["b", "d"]);
  assert.equal(node(merged, "b").x, 1);
});

test("additions from both sides are kept, local additions after their local neighbour", () => {
  const base = graph([rect("a"), rect("b")]);
  const local = graph([rect("a"), rect("mine"), rect("b"), rect("mine-top")]);
  const remote = graph([rect("a"), rect("b"), rect("theirs")]);
  assert.deepEqual(ids(mergeCanvasStates(base, local, remote)), ["a", "mine", "b", "theirs", "mine-top"]);
});

test("z-order follows a remote reorder unless this tab reordered", () => {
  const base = graph([rect("a"), rect("b"), rect("c")]);
  const remoteReordered = graph([rect("c"), rect("a"), rect("b")]);
  assert.deepEqual(ids(mergeCanvasStates(base, base, remoteReordered)), ["c", "a", "b"]);
  const localReordered = graph([rect("b"), rect("a"), rect("c")]);
  assert.deepEqual(ids(mergeCanvasStates(base, localReordered, remoteReordered)), ["b", "a", "c"]);
  const remoteAdded = graph([rect("a"), rect("b"), rect("c"), rect("new")]);
  assert.deepEqual(ids(mergeCanvasStates(base, localReordered, remoteAdded)), ["b", "a", "c", "new"]);
});

test("references to nodes deleted on the other side are released", () => {
  const base = graph([rect("frame", { type: "frame" }), rect("x"), rect("y")], [arrow("c1", "x", "y")]);
  const local = graph([rect("frame", { type: "frame" }), rect("x", { parentId: "frame" }), rect("y")], [arrow("c1", "x", "y"), arrow("c2", "y", "x")]);
  const remote = graph([rect("x"), rect("z")], [arrow("c1", "x", "y")]);
  const merged = mergeCanvasStates(base, local, remote);
  // Remote deleted the frame (local did not edit it) and y; local's edit to x keeps it, released from the frame.
  assert.deepEqual(ids(merged), ["x", "z"]);
  assert.equal(node(merged, "x").parentId, null);
  assert.deepEqual(merged.connectors, []);
});

test("the viewport is each person's own", () => {
  const base = graph([], [], { x: 0, y: 0, zoom: 1 });
  const local = graph([], [], { x: 50, y: 0, zoom: 2 });
  const remote = graph([rect("a")], [], { x: -9, y: -9, zoom: 0.5 });
  assert.deepEqual(mergeCanvasStates(base, local, remote).viewport, { x: 50, y: 0, zoom: 2 });
});

test("unchanged items keep their identity and a no-op merge returns the local graph", () => {
  const a = rect("a");
  const b = rect("b");
  const base = graph([a, b]);
  const local = graph([a, b]);
  assert.equal(mergeCanvasStates(base, local, graph([rect("a"), rect("b")])), local);
  const merged = mergeCanvasStates(base, local, graph([rect("a"), rect("b", { x: 4 })]));
  assert.equal(merged.nodes[0], a);
  assert.notEqual(merged.nodes[1], b);
});

test("structural equality ignores key order and undefined keys", () => {
  assert.equal(sameValue({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 }), true);
  assert.equal(sameValue({ a: 1, b: undefined }, { a: 1 }), true);
  assert.equal(sameValue({ a: [1] }, { a: { 0: 1 } }), false);
  assert.equal(sameValue(null, {}), false);
});

test("undo after a merge reverts only this person's own step", () => {
  const base = graph([rect("mine"), rect("theirs")]);
  // This person moved `mine`; the move is one undo step.
  let history = commit({ past: [], present: base, future: [] }, graph([rect("mine", { x: 40 }), rect("theirs")]));
  const remote = graph([rect("mine"), rect("theirs", { fill: "#f00" }), rect("added")]);
  history = rebaseHistory(history, base, remote);
  assert.equal(node(history.present, "mine").x, 40);
  assert.equal(node(history.present, "theirs").fill, "#f00");
  const undone = undo(history);
  assert.equal(node(undone.present, "mine").x, 0);
  assert.equal(node(undone.present, "theirs").fill, "#f00");
  assert.deepEqual(ids(undone.present), ["mine", "theirs", "added"]);
});

test("undoing a step on a node someone else also changed reveals their version", () => {
  const base = graph([rect("shared")]);
  let history = commit({ past: [], present: base, future: [] }, graph([rect("shared", { x: 40 })]));
  history = rebaseHistory(history, base, graph([rect("shared", { y: 70 })]));
  assert.deepEqual(node(history.present, "shared"), rect("shared", { x: 40 }));
  assert.deepEqual(node(undo(history).present, "shared"), rect("shared", { y: 70 }));
});
