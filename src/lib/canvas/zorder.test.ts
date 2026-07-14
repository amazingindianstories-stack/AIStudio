/**
 * Unit tests for src/lib/canvas/zorder.ts — pure array-reorder helpers for
 * layer ordering (spec.md AC #3 "Layer ordering: bring to front / send to
 * back / forward / backward").
 *
 * Derived independently from design.md's Interfaces section
 * ("bringToFront/sendToBack/bringForward/sendBackward(nodes, ids): CanvasNode[]")
 * and Data model note "ARRAY ORDER == Z-ORDER (index 0 = back, last = front)",
 * BEFORE reading any implementation. Pure module: no DOM, no network. Run:
 *   npx tsx --test src/lib/canvas/zorder.test.ts
 *
 * Interpreted ambiguity: design.md does not specify the exact multi-select
 * reordering algorithm for bringForward/sendBackward (only that it must be
 * "correct" for multi-node selections). Tests assume the common convention
 * that the selected subset moves together, as a block, past its nearest
 * unselected neighbor in that direction, preserving the selected subset's
 * own relative order. See final report for how to interpret a mismatch here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { bringToFront, sendToBack, bringForward, sendBackward } from "./zorder";
import type { CanvasNode, ShapeNode } from "./types";

function node(id: string): ShapeNode {
  return {
    id,
    type: "rect",
    x: 0,
    y: 0,
    w: 10,
    h: 10,
    fill: "#fff",
    stroke: "#000",
    strokeWidth: 1,
    parentId: null,
    groupId: null,
  };
}

// Back -> front: A, B, C, D, E (index 0 = back, index 4 = front).
function baseNodes(): ShapeNode[] {
  return ["A", "B", "C", "D", "E"].map(node);
}

function ids(nodes: CanvasNode[]): string[] {
  return nodes.map((n) => n.id);
}

// ---------------------------------------------------------------------------
// bringToFront
// ---------------------------------------------------------------------------

test("bringToFront: single node moves to the end (front), other nodes keep relative order", () => {
  const result = bringToFront(baseNodes(), ["B"]);
  assert.deepEqual(ids(result), ["A", "C", "D", "E", "B"]);
});

test("bringToFront: multi-node selection moves to the end together, preserving the selection's own relative order", () => {
  const result = bringToFront(baseNodes(), ["B", "D"]);
  assert.deepEqual(ids(result), ["A", "C", "E", "B", "D"]);
});

test("bringToFront: an already-front node brought to front again is idempotent / a no-op", () => {
  const result = bringToFront(baseNodes(), ["E"]);
  assert.deepEqual(ids(result), ["A", "B", "C", "D", "E"]);
});

test("bringToFront: empty selection does not throw and leaves order unchanged", () => {
  assert.doesNotThrow(() => bringToFront(baseNodes(), []));
  const result = bringToFront(baseNodes(), []);
  assert.deepEqual(ids(result), ["A", "B", "C", "D", "E"]);
});

test("bringToFront: unknown id in the selection does not throw and the known id still reorders correctly", () => {
  assert.doesNotThrow(() => bringToFront(baseNodes(), ["B", "nonexistent"]));
  const result = bringToFront(baseNodes(), ["B", "nonexistent"]);
  assert.ok(ids(result).includes("B"));
  assert.equal(ids(result)[ids(result).length - 1], "B", "B (the only real id) should end up front-most");
  assert.equal(result.length, 5, "the phantom id must not be inserted as a node");
});

test("bringToFront: does not mutate the input array", () => {
  const input = baseNodes();
  const snapshotIds = ids(input);
  bringToFront(input, ["B"]);
  assert.deepEqual(ids(input), snapshotIds);
});

// ---------------------------------------------------------------------------
// sendToBack
// ---------------------------------------------------------------------------

test("sendToBack: single node moves to the start (back), other nodes keep relative order", () => {
  const result = sendToBack(baseNodes(), ["D"]);
  assert.deepEqual(ids(result), ["D", "A", "B", "C", "E"]);
});

test("sendToBack: multi-node selection moves to the start together, preserving the selection's own relative order", () => {
  const result = sendToBack(baseNodes(), ["B", "D"]);
  assert.deepEqual(ids(result), ["B", "D", "A", "C", "E"]);
});

test("sendToBack: an already-back node sent to back again is idempotent / a no-op", () => {
  const result = sendToBack(baseNodes(), ["A"]);
  assert.deepEqual(ids(result), ["A", "B", "C", "D", "E"]);
});

test("sendToBack: empty selection does not throw and leaves order unchanged", () => {
  const result = sendToBack(baseNodes(), []);
  assert.deepEqual(ids(result), ["A", "B", "C", "D", "E"]);
});

// ---------------------------------------------------------------------------
// bringForward
// ---------------------------------------------------------------------------

test("bringForward: single node swaps forward with its immediate front neighbor", () => {
  const result = bringForward(baseNodes(), ["B"]);
  assert.deepEqual(ids(result), ["A", "C", "B", "D", "E"]);
});

test("bringForward: an already-front node is idempotent / a no-op at the boundary", () => {
  const result = bringForward(baseNodes(), ["E"]);
  assert.deepEqual(ids(result), ["A", "B", "C", "D", "E"]);
});

test("bringForward: multi-node adjacent selection at the back moves forward past the next node as a block", () => {
  const result = bringForward(baseNodes(), ["A", "B"]);
  assert.deepEqual(ids(result), ["C", "A", "B", "D", "E"]);
});

test("bringForward: contains no duplicate/lost ids regardless of selection", () => {
  const result = bringForward(baseNodes(), ["B", "D"]);
  assert.deepEqual(ids(result).slice().sort(), ["A", "B", "C", "D", "E"]);
  assert.equal(result.length, 5);
});

// ---------------------------------------------------------------------------
// sendBackward
// ---------------------------------------------------------------------------

test("sendBackward: single node swaps backward with its immediate back neighbor", () => {
  const result = sendBackward(baseNodes(), ["D"]);
  assert.deepEqual(ids(result), ["A", "B", "D", "C", "E"]);
});

test("sendBackward: an already-back node is idempotent / a no-op at the boundary", () => {
  const result = sendBackward(baseNodes(), ["A"]);
  assert.deepEqual(ids(result), ["A", "B", "C", "D", "E"]);
});

test("sendBackward: multi-node adjacent selection at the front moves backward past the previous node as a block", () => {
  const result = sendBackward(baseNodes(), ["D", "E"]);
  assert.deepEqual(ids(result), ["A", "B", "D", "E", "C"]);
});

test("sendBackward: contains no duplicate/lost ids regardless of selection", () => {
  const result = sendBackward(baseNodes(), ["B", "D"]);
  assert.deepEqual(ids(result).slice().sort(), ["A", "B", "C", "D", "E"]);
  assert.equal(result.length, 5);
});

// ---------------------------------------------------------------------------
// Cross-cutting boundary checks
// ---------------------------------------------------------------------------

test("all four ops on a single-node array are no-ops that do not throw", () => {
  const single = [node("only")];
  assert.doesNotThrow(() => bringToFront(single, ["only"]));
  assert.doesNotThrow(() => sendToBack(single, ["only"]));
  assert.doesNotThrow(() => bringForward(single, ["only"]));
  assert.doesNotThrow(() => sendBackward(single, ["only"]));
  assert.deepEqual(ids(bringToFront(single, ["only"])), ["only"]);
  assert.deepEqual(ids(sendToBack(single, ["only"])), ["only"]);
});

test("all four ops on an empty node array do not throw", () => {
  assert.doesNotThrow(() => bringToFront([], ["x"]));
  assert.doesNotThrow(() => sendToBack([], ["x"]));
  assert.doesNotThrow(() => bringForward([], ["x"]));
  assert.doesNotThrow(() => sendBackward([], ["x"]));
});
