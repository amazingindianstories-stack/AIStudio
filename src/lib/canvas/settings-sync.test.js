/**
 * Board settings (background, start view, layers) through save patches,
 * `/changes` replies and the three-way merge of a concurrent edit.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { applyBoardPatch, boardFromChanges, buildBoardPatch, orderHash } from "./patch.js";
import { mergeCanvasStates } from "./merge.js";
import { emptyCanvasState } from "./serialization.js";

const rect = (id, extra = {}) => ({ id, type: "rect", x: 0, y: 0, w: 10, h: 10, ...extra });
const board = (nodes, settings) => {
  const graph = { ...emptyCanvasState(), nodes, connectors: [] };
  if (settings) graph.settings = settings;
  return graph;
};
const layers = (...names) => names.map((name) => ({ id: name.toLowerCase(), name }));

test("a patch sends changed settings whole and leaves unchanged ones out", () => {
  const base = board([rect("a")], { background: "#101010", layers: layers("Sketch") });
  assert.equal("settings" in buildBoardPatch(base, board([rect("a")], { background: "#101010", layers: layers("Sketch") })), false);
  const next = board([rect("a")], { background: "#202020", layers: layers("Sketch") });
  const patch = buildBoardPatch(base, next);
  assert.deepEqual(patch.settings, { background: "#202020", layers: layers("Sketch") });
  assert.deepEqual(applyBoardPatch(base, patch), next);
});

test("clearing every setting sends null, which removes the settings key", () => {
  const base = board([rect("a")], { layers: layers("Sketch") });
  const next = board([rect("a")]);
  const patch = buildBoardPatch(base, next);
  assert.equal(patch.settings, null);
  const applied = applyBoardPatch(base, patch);
  assert.equal("settings" in applied, false);
  assert.deepEqual(applied, next);
});

test("a /changes reply with settings rebuilds the board with them", () => {
  const base = board([rect("a")]);
  const settings = { startView: { x: 1, y: 2, zoom: 0.5 }, layers: layers("Top") };
  const changes = {
    nodes: { upsert: [rect("a", { layerId: "top" })], add: [], delete: [] },
    connectors: { upsert: [], add: [], delete: [] },
    settings,
    nodeOrderHash: orderHash(["a"]),
    connectorOrderHash: orderHash([]),
  };
  assert.deepEqual(boardFromChanges(base, changes), board([rect("a", { layerId: "top" })], settings));
  // A reply whose settings are null clears them; one without settings keeps them.
  const withSettings = board([rect("a")], settings);
  assert.equal("settings" in boardFromChanges(withSettings, { ...changes, nodes: { upsert: [], add: [], delete: [] }, settings: null }), false);
  const { settings: _omit, ...noSettings } = changes;
  assert.deepEqual(boardFromChanges(withSettings, { ...noSettings, nodes: { upsert: [], add: [], delete: [] } }).settings, settings);
});

test("settings merge per key: each side's change lands, and local wins a key both changed", () => {
  const base = board([], { background: "#000000", layers: layers("A") });
  const local = board([], { background: "#111111", layers: layers("A") });
  const remote = board([], { background: "#000000", layers: layers("A", "B"), startView: { x: 0, y: 0, zoom: 2 } });
  assert.deepEqual(mergeCanvasStates(base, local, remote).settings, {
    background: "#111111",
    layers: layers("A", "B"),
    startView: { x: 0, y: 0, zoom: 2 },
  });
  const both = board([], { background: "#222222", layers: layers("A") });
  assert.equal(mergeCanvasStates(base, local, both).settings.background, "#111111");
});

test("layers merge per layer: layers added on both sides both stay", () => {
  const base = board([]);
  const local = board([], { layers: layers("B") });
  const remote = board([], { layers: layers("A") });
  assert.deepEqual(mergeCanvasStates(base, local, remote).settings.layers, layers("A", "B"));
  // The other tab's next poll keeps both too.
  assert.deepEqual(mergeCanvasStates(remote, remote, board([], { layers: layers("A", "B") })).settings.layers, layers("A", "B"));
});

test("a layer both sides changed merges per field, and changes to different layers both land", () => {
  const base = board([], { layers: layers("A", "B") });
  const local = board([], { layers: [{ id: "a", name: "Renamed" }, { id: "b", name: "B" }] });
  const remote = board([], { layers: [{ id: "a", name: "A", locked: true }, { id: "b", name: "B", locked: true }] });
  assert.deepEqual(mergeCanvasStates(base, local, remote).settings.layers, [
    { id: "a", name: "Renamed", locked: true },
    { id: "b", name: "B", locked: true },
  ]);
});

test("a deleted layer goes only when the other side left it unchanged; a reorder on one side keeps", () => {
  const base = board([], { layers: layers("A", "B", "C") });
  const local = board([], { layers: layers("A", "C") });
  assert.deepEqual(mergeCanvasStates(base, local, base).settings.layers, layers("A", "C"));
  const relocked = board([], { layers: [...layers("A"), { id: "b", name: "B", locked: true }, ...layers("C")] });
  assert.deepEqual(mergeCanvasStates(base, local, relocked).settings.layers.map((l) => l.id), ["a", "b", "c"]);
  const reordered = board([], { layers: layers("C", "A", "B") });
  assert.deepEqual(mergeCanvasStates(base, reordered, board([], { layers: layers("A", "B", "C", "D") })).settings.layers, layers("C", "A", "B", "D"));
});

test("a setting removed on one side is removed in the merge, and all removed drops the key", () => {
  const base = board([], { background: "#000000", layers: layers("A") });
  const local = board([], { background: "#000000", layers: layers("A") });
  const remote = board([], { layers: layers("A") });
  assert.deepEqual(mergeCanvasStates(base, local, remote).settings, { layers: layers("A") });
  const cleared = mergeCanvasStates(base, local, board([]));
  assert.equal("settings" in cleared, false);
});

test("identical settings on both sides keep the local board object", () => {
  const base = board([rect("a")]);
  const local = board([rect("a")], { layers: layers("A") });
  const remote = { ...local, settings: { layers: layers("A") } };
  assert.equal(mergeCanvasStates(base, local, remote), local);
});
