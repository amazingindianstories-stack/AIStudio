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
