import assert from "node:assert/strict";
import test from "node:test";
import { frameChildren, frameOrderEdits, frameTitle, moveInOrder, orderedFrames, organizeFrameEdits } from "./frames.js";

const frame = (id, x, y, extra = {}) => ({ id, type: "frame", name: id, x, y, w: 200, h: 100, parentId: null, groupId: null, ...extra });

test("frames with a stored order come first, the rest follow in reading order", () => {
  const board = { nodes: [frame("c", 0, 500), frame("a", 0, 0), frame("b", 400, 0, { frameOrder: 0 })], connectors: [] };
  assert.deepEqual(orderedFrames(board).map((f) => f.id), ["b", "a", "c"]);
});

test("storing an order only edits frames whose place changed", () => {
  const board = { nodes: [frame("a", 0, 0, { frameOrder: 0 }), frame("b", 400, 0, { frameOrder: 1 }), frame("c", 800, 0, { frameOrder: 2 })], connectors: [] };
  const edits = frameOrderEdits(board, ["a", "c", "b"]);
  assert.deepEqual([...edits.keys()].sort(), ["b", "c"]);
  assert.equal(edits.get("c").frameOrder, 1);
  assert.equal(edits.get("b").frameOrder, 2);
  assert.equal(frameOrderEdits(board, ["a", "b", "c"]).size, 0);
});

test("moving a block of frames keeps their order and lands before the target", () => {
  assert.deepEqual(moveInOrder(["a", "b", "c", "d"], ["c", "a"], "d"), ["b", "a", "c", "d"]);
  assert.deepEqual(moveInOrder(["a", "b", "c", "d"], ["a"], null), ["b", "c", "d", "a"]);
  assert.deepEqual(moveInOrder(["a", "b", "c"], ["a", "b"], "b"), ["a", "b", "c"]);
});

test("organize lays frames in a grid in order and moves their contents along", () => {
  const board = {
    nodes: [
      frame("one", 0, 0, { frameOrder: 0 }),
      frame("two", 5000, 3000, { frameOrder: 1 }),
      frame("three", -50, 900, { frameOrder: 2 }),
      { id: "child", type: "sticky", x: 5010, y: 3010, w: 50, h: 50, parentId: "two", groupId: null },
    ],
    connectors: [],
  };
  const edits = organizeFrameEdits(board, 80);
  // Two columns for three frames, starting at the frames' top-left corner.
  assert.deepEqual([edits.get("one").x, edits.get("one").y], [-50, 0]);
  assert.deepEqual([edits.get("two").x, edits.get("two").y], [230, 0]);
  assert.deepEqual([edits.get("three").x, edits.get("three").y], [-50, 180]);
  assert.deepEqual([edits.get("child").x, edits.get("child").y], [240, 10]);
  assert.equal(organizeFrameEdits({ nodes: [], connectors: [] }).size, 0);
});

test("frame children and titles", () => {
  const board = { nodes: [frame("f", 0, 0, { name: "  " }), { id: "n", type: "text", parentId: "f" }], connectors: [] };
  assert.deepEqual(frameChildren(board, board.nodes[0]).map((n) => n.id), ["n"]);
  assert.equal(frameTitle(board.nodes[0]), "Untitled frame");
  assert.equal(frameTitle({ name: "Intro" }), "Intro");
});
