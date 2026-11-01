import assert from "node:assert/strict";
import test from "node:test";
import { frameChildren, frameOrderEdits, frameTitle, moveInOrder, moveInOrderLocked, orderedFrames, organizeFrameEdits, reorderFrameEdits } from "./frames.js";
import { isLocked } from "./locks.js";

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

test("reordering around a locked frame keeps it in its slot", () => {
  const locked = new Set(["a"]);
  // c goes first: the locked a stays at index 0, so c lands before b instead.
  assert.deepEqual(moveInOrderLocked(["a", "b", "c"], ["c"], "a", locked), ["a", "c", "b"]);
  assert.deepEqual(moveInOrderLocked(["a", "b", "c"], ["c"], "b", locked), ["a", "c", "b"]);
  // A locked frame is never the one moved.
  assert.deepEqual(moveInOrderLocked(["a", "b", "c"], ["a"], null, locked), ["a", "b", "c"]);
  assert.deepEqual(moveInOrderLocked(["a", "b", "c"], ["b"], null, locked), ["a", "c", "b"]);
  assert.deepEqual(moveInOrderLocked(["a", "b", "c"], ["c"], "b", new Set()), ["a", "c", "b"]);
});

// The board after `edits` as the store saves them: edits to locked objects are dropped.
const saved = (board, edits) => ({ ...board, nodes: board.nodes.map((n) => (isLocked(board, n) ? n : edits.get(n.id) ?? n)) });
const order = (board) => orderedFrames(board).map((f) => f.id);

test("a reorder that would move an unplaced locked frame is refused instead of sending it last", () => {
  const board = { nodes: [frame("a", 0, 0, { locked: true }), frame("b", 400, 0), frame("c", 800, 0)], connectors: [] };
  // Saving c first would give a no place while b and c get one, so a would read last (c, b, a).
  assert.equal(reorderFrameEdits(board, ["c"], "a"), null);
  assert.equal(reorderFrameEdits(board, ["c"], "b"), null);
  // b cannot pass the locked a: nothing changes and nothing is sent.
  assert.equal(reorderFrameEdits(board, ["b"], "a").size, 0);
});

test("reordering around a placed locked frame keeps it in its slot once saved", () => {
  const board = { nodes: [frame("a", 0, 0, { locked: true, frameOrder: 0 }), frame("b", 400, 0, { frameOrder: 1 }), frame("c", 800, 0, { frameOrder: 2 })], connectors: [] };
  assert.deepEqual(order(saved(board, reorderFrameEdits(board, ["c"], "a"))), ["a", "c", "b"]);
  assert.deepEqual(order(saved(board, reorderFrameEdits(board, ["b"], null))), ["a", "c", "b"]);
  // A locked frame last with no stored place keeps reading last.
  const last = { nodes: [frame("a", 0, 0), frame("b", 400, 0), frame("c", 800, 0, { locked: true })], connectors: [] };
  const edits = reorderFrameEdits(last, ["b"], "a");
  assert.equal(edits.has("c"), false);
  assert.deepEqual(order(saved(last, edits)), ["b", "a", "c"]);
  // Without locks every frame gets a place.
  const open = { nodes: [frame("a", 0, 0), frame("b", 400, 0), frame("c", 800, 0)], connectors: [] };
  assert.deepEqual(order(saved(open, reorderFrameEdits(open, ["c"], "a"))), ["c", "a", "b"]);
});

test("organize leaves locked frames and their contents in place, and locked contents of moved frames", () => {
  const board = {
    nodes: [
      frame("one", 0, 0, { frameOrder: 0, locked: true }),
      frame("two", 5000, 3000, { frameOrder: 1 }),
      frame("three", 900, 900, { frameOrder: 2 }),
      { id: "inLocked", type: "sticky", x: 10, y: 10, w: 50, h: 50, parentId: "one", groupId: null },
      { id: "pinned", type: "sticky", x: 5010, y: 3010, w: 50, h: 50, parentId: "two", groupId: null, locked: true },
      { id: "free", type: "sticky", x: 5100, y: 3010, w: 50, h: 50, parentId: "two", groupId: null },
    ],
    connectors: [],
  };
  const edits = organizeFrameEdits(board, 80);
  assert.deepEqual([...edits.keys()].sort(), ["free", "three", "two"]);
  // The unlocked frames form the grid from their own top-left corner.
  assert.deepEqual([edits.get("two").x, edits.get("two").y], [900, 900]);
  assert.deepEqual([edits.get("three").x, edits.get("three").y], [1180, 900]);
  assert.deepEqual([edits.get("free").x, edits.get("free").y], [1000, 910]);
  const allLocked = { nodes: [frame("x", 0, 0, { locked: true }), frame("y", 900, 0, { locked: true })], connectors: [] };
  assert.equal(organizeFrameEdits(allLocked).size, 0);
});

test("organize steps past a locked frame inside the grid instead of landing on it", () => {
  const board = {
    nodes: [
      frame("b", 0, 0, { frameOrder: 0 }),
      frame("a", 280, 0, { frameOrder: 1, locked: true }),
      frame("c", 560, 0, { frameOrder: 2 }),
      frame("d", 3000, 3000, { frameOrder: 3 }),
      { id: "kid", type: "sticky", x: 570, y: 10, w: 50, h: 50, parentId: "c", groupId: null },
    ],
    connectors: [],
  };
  const after = saved(board, organizeFrameEdits(board, 80));
  const at = Object.fromEntries(after.nodes.map((n) => [n.id, [n.x, n.y]]));
  assert.deepEqual(at, { b: [0, 0], a: [280, 0], c: [560, 0], d: [0, 180], kid: [570, 10] });
  const locked = after.nodes.find((n) => n.id === "a");
  for (const f of after.nodes.filter((n) => n.type === "frame" && n.id !== "a")) {
    const apart = f.x + f.w + 80 <= locked.x || locked.x + locked.w + 80 <= f.x || f.y + f.h + 80 <= locked.y || locked.y + locked.h + 80 <= f.y;
    assert.ok(apart, `${f.id} keeps the gap from the locked frame`);
  }
});
