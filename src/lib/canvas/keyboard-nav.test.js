import assert from "node:assert/strict";
import test from "node:test";
import { edgeStop, enterContainer, leaveContainer, navigationStops, readingOrder, spatialNeighbor, stepStop } from "./keyboard-nav.js";

const box = (id, x, y, extra = {}) => ({ id, type: "sticky", x, y, w: 100, h: 100, parentId: null, groupId: null, ...extra });

// Two rows at the top level, a frame holding two notes, and a group of two.
const board = {
  nodes: [
    box("b", 300, 10),
    box("a", 0, 0),
    box("c", 0, 300),
    box("frame", 600, 300, { type: "frame", w: 400, h: 300 }),
    box("in2", 800, 350, { parentId: "frame" }),
    box("in1", 620, 340, { parentId: "frame" }),
    box("g1", 0, 600, { groupId: "g" }),
    box("g2", 150, 600, { groupId: "g" }),
  ],
  connectors: [],
};

test("reading order goes row by row, left to right, tolerating small vertical offsets", () => {
  assert.deepEqual(readingOrder(board.nodes.filter((n) => !n.parentId)), ["a", "b", "c", "frame", "g1", "g2"]);
});

test("a group is one stop and frame contents are their own level", () => {
  const top = navigationStops(board, null).map((s) => s.ids);
  assert.deepEqual(top, [["a"], ["b"], ["c"], ["frame"], ["g1", "g2"]]);
  assert.deepEqual(navigationStops(board, "frame").map((s) => s.ids), [["in1"], ["in2"]]);
});

test("Tab steps through the selection's level, wrapping inside a frame", () => {
  assert.deepEqual(stepStop(board, [], 1), ["a"]);
  assert.deepEqual(stepStop(board, [], -1), ["g1", "g2"]);
  assert.deepEqual(stepStop(board, ["a"], 1), ["b"]);
  assert.deepEqual(stepStop(board, ["b"], -1), ["a"]);
  assert.deepEqual(stepStop(board, ["in1"], 1), ["in2"]);
  assert.deepEqual(stepStop(board, ["in2"], 1), ["in1"]);
  assert.deepEqual(stepStop(board, ["in1"], -1), ["in2"]);
});

test("at the top level Tab past the last stop and Shift+Tab before the first leave the board", () => {
  assert.equal(stepStop(board, ["g1", "g2"], 1), null);
  assert.equal(stepStop(board, ["a"], -1), null);
});

test("Home and End pick the first and last stop at the level", () => {
  assert.deepEqual(edgeStop(board, [], "first"), ["a"]);
  assert.deepEqual(edgeStop(board, ["b"], "last"), ["g1", "g2"]);
  assert.deepEqual(edgeStop(board, ["in2"], "first"), ["in1"]);
  assert.equal(edgeStop({ nodes: [], connectors: [] }, [], "first"), null);
});

test("Enter goes into a frame or group and Escape comes back out", () => {
  assert.deepEqual(enterContainer(board, ["frame"]), ["in1"]);
  assert.deepEqual(enterContainer(board, ["g1", "g2"]), ["g1"]);
  assert.equal(enterContainer(board, ["a"]), null);
  assert.deepEqual(leaveContainer(board, ["in2"]), ["frame"]);
  assert.deepEqual(leaveContainer(board, ["g2"]), ["g1", "g2"]);
  assert.equal(leaveContainer(board, ["a"]), null);
});

test("Enter goes into a swimlane or diagram like a frame, and Escape comes back out", () => {
  const containers = {
    nodes: [
      box("lane", 0, 0, { type: "swimlane", w: 600, h: 300 }),
      box("s2", 300, 150, { parentId: "lane" }),
      box("s1", 150, 40, { parentId: "lane" }),
      box("dia", 0, 400, { type: "diagram", w: 400, h: 300 }),
      box("d1", 50, 450, { parentId: "dia" }),
      box("empty", 700, 0, { type: "swimlane", w: 300, h: 200 }),
    ],
    connectors: [],
  };
  assert.deepEqual(navigationStops(containers, null).map((s) => s.ids), [["lane"], ["empty"], ["dia"]]);
  assert.deepEqual(enterContainer(containers, ["lane"]), ["s1"]);
  assert.deepEqual(stepStop(containers, ["s1"], 1), ["s2"]);
  assert.deepEqual(leaveContainer(containers, ["s2"]), ["lane"]);
  assert.deepEqual(enterContainer(containers, ["dia"]), ["d1"]);
  assert.equal(enterContainer(containers, ["empty"]), null);
});

test("Cmd+arrows find the nearest object ahead, preferring straight ahead", () => {
  assert.equal(spatialNeighbor(board, ["a"], "right"), "b");
  assert.equal(spatialNeighbor(board, ["a"], "down"), "c");
  assert.equal(spatialNeighbor(board, ["a"], "left"), null);
  assert.equal(spatialNeighbor(board, ["c"], "up"), "a");
  assert.equal(spatialNeighbor(board, ["a"], "sideways"), null);
});
