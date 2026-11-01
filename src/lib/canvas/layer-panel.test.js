import assert from "node:assert/strict";
import test from "node:test";
import { dropIndex, layerRows, objectCountLabel } from "./layer-panel.js";
import { moveLayer } from "./layers.js";

const rect = (id, layerId) => ({ id, type: "rect", x: 0, y: 0, w: 1, h: 1, ...(layerId ? { layerId } : {}) });
const board = {
  nodes: [rect("a"), rect("b", "L1"), rect("c", "L2"), rect("d", "L2"), rect("e", "gone")],
  connectors: [],
  settings: { layers: [{ id: "L1", name: "One" }, { id: "L2", name: "Two", locked: true }, { id: "L3", name: "Three" }] },
};
const order = (state) => state.settings.layers.map((layer) => layer.id);

test("rows list the top layer first and the default layer last, with object counts", () => {
  assert.deepEqual(
    layerRows(board).map(({ id, name, count, locked, isDefault }) => [id, name, count, locked, isDefault]),
    [
      ["L3", "Three", 0, false, false],
      ["L2", "Two", 2, true, false],
      ["L1", "One", 1, false, false],
      // An object naming an unknown layer is drawn on the default one.
      [null, "Default layer", 2, false, true],
    ]
  );
  assert.deepEqual(layerRows({ nodes: [rect("a")] }).map((row) => row.id), [null]);
});

test("dropping a layer on the upper half of a row puts it above that row, else below", () => {
  const drop = (dragged, target, above) => order(moveLayer(board, dragged, dropIndex(board, dragged, target, above)));
  assert.deepEqual(drop("L1", "L3", true), ["L2", "L3", "L1"]);
  assert.deepEqual(drop("L1", "L3", false), ["L2", "L1", "L3"]);
  assert.deepEqual(drop("L3", "L1", false), ["L3", "L1", "L2"]);
  assert.deepEqual(drop("L3", "L1", true), ["L1", "L3", "L2"]);
  assert.deepEqual(drop("L3", null, true), ["L3", "L1", "L2"], "onto the default row: the bottom custom layer");
  assert.equal(dropIndex(board, "nope", "L1", true), -1);
});

test("object counts read naturally", () => {
  assert.equal(objectCountLabel(0), "Empty");
  assert.equal(objectCountLabel(1), "1 object");
  assert.equal(objectCountLabel(12), "12 objects");
});
