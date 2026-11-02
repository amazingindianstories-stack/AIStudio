import assert from "node:assert/strict";
import test from "node:test";
import {
  FRAME_PRESETS, applyFramePreset, copyOrigin, enclosingContainerId, frameAroundSelection, frameChildren, frameOrderEdits, frameTitle, holdsCopied,
  incrementDates, keepHiddenFrames, moveInOrder, moveInOrderLocked, orderedFrames, organizeFrameEdits, pasteDestinations, presetOfFrame,
  renameDuplicatedFrames, renestFrames, reorderFrameEdits,
} from "./frames.js";
import { applyFrameMove, descendantIds, moveNodesBy } from "./geometry.js";
import { isLocked } from "./locks.js";

const orderFrame = (id, x, y, extra = {}) => ({ id, type: "frame", name: id, x, y, w: 200, h: 100, parentId: null, groupId: null, ...extra });

test("frames with a stored order come first, the rest follow in reading order", () => {
  const board = { nodes: [orderFrame("c", 0, 500), orderFrame("a", 0, 0), orderFrame("b", 400, 0, { frameOrder: 0 })], connectors: [] };
  assert.deepEqual(orderedFrames(board).map((f) => f.id), ["b", "a", "c"]);
});

test("storing an order only edits frames whose place changed", () => {
  const board = { nodes: [orderFrame("a", 0, 0, { frameOrder: 0 }), orderFrame("b", 400, 0, { frameOrder: 1 }), orderFrame("c", 800, 0, { frameOrder: 2 })], connectors: [] };
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
      orderFrame("one", 0, 0, { frameOrder: 0 }),
      orderFrame("two", 5000, 3000, { frameOrder: 1 }),
      orderFrame("three", -50, 900, { frameOrder: 2 }),
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
  const board = { nodes: [orderFrame("f", 0, 0, { name: "  " }), { id: "n", type: "text", parentId: "f" }], connectors: [] };
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
  const board = { nodes: [orderFrame("a", 0, 0, { locked: true }), orderFrame("b", 400, 0), orderFrame("c", 800, 0)], connectors: [] };
  // Saving c first would give a no place while b and c get one, so a would read last (c, b, a).
  assert.equal(reorderFrameEdits(board, ["c"], "a"), null);
  assert.equal(reorderFrameEdits(board, ["c"], "b"), null);
  // b cannot pass the locked a: nothing changes and nothing is sent.
  assert.equal(reorderFrameEdits(board, ["b"], "a").size, 0);
});

test("reordering around a placed locked frame keeps it in its slot once saved", () => {
  const board = { nodes: [orderFrame("a", 0, 0, { locked: true, frameOrder: 0 }), orderFrame("b", 400, 0, { frameOrder: 1 }), orderFrame("c", 800, 0, { frameOrder: 2 })], connectors: [] };
  assert.deepEqual(order(saved(board, reorderFrameEdits(board, ["c"], "a"))), ["a", "c", "b"]);
  assert.deepEqual(order(saved(board, reorderFrameEdits(board, ["b"], null))), ["a", "c", "b"]);
  // A locked frame last with no stored place keeps reading last.
  const last = { nodes: [orderFrame("a", 0, 0), orderFrame("b", 400, 0), orderFrame("c", 800, 0, { locked: true })], connectors: [] };
  const edits = reorderFrameEdits(last, ["b"], "a");
  assert.equal(edits.has("c"), false);
  assert.deepEqual(order(saved(last, edits)), ["b", "a", "c"]);
  // Without locks every frame gets a place.
  const open = { nodes: [orderFrame("a", 0, 0), orderFrame("b", 400, 0), orderFrame("c", 800, 0)], connectors: [] };
  assert.deepEqual(order(saved(open, reorderFrameEdits(open, ["c"], "a"))), ["c", "a", "b"]);
});

test("organize leaves locked frames and their contents in place, and locked contents of moved frames", () => {
  const board = {
    nodes: [
      orderFrame("one", 0, 0, { frameOrder: 0, locked: true }),
      orderFrame("two", 5000, 3000, { frameOrder: 1 }),
      orderFrame("three", 900, 900, { frameOrder: 2 }),
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
  const allLocked = { nodes: [orderFrame("x", 0, 0, { locked: true }), orderFrame("y", 900, 0, { locked: true })], connectors: [] };
  assert.equal(organizeFrameEdits(allLocked).size, 0);
});

test("organize steps past a locked frame inside the grid instead of landing on it", () => {
  const board = {
    nodes: [
      orderFrame("b", 0, 0, { frameOrder: 0 }),
      orderFrame("a", 280, 0, { frameOrder: 1, locked: true }),
      orderFrame("c", 560, 0, { frameOrder: 2 }),
      orderFrame("d", 3000, 3000, { frameOrder: 3 }),
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

const box = (id, x, y, w = 50, h = 50, extra = {}) => ({ id, type: "rect", x, y, w, h, parentId: null, groupId: null, ...extra });
const frame = (id, x, y, w, h, extra = {}) => ({ id, type: "frame", name: id, fill: "transparent", stroke: "#000", x, y, w, h, parentId: null, groupId: null, ...extra });

test("create frame around selection: bounds plus padding, behind the selection, selection reparented", () => {
  const state = { nodes: [box("under", 900, 900), box("a", 100, 100), box("b", 300, 200, 80, 60)], connectors: [] };
  const { state: next, frameId } = frameAroundSelection(state, ["a", "b"], 40, "f");
  const made = next.nodes.find((n) => n.id === "f");
  assert.deepEqual([made.x, made.y, made.w, made.h], [60, 60, 360, 240]);
  assert.equal(frameId, "f");
  assert.deepEqual(next.nodes.map((n) => n.id), ["under", "f", "a", "b"], "the frame sits right behind the first selected object");
  assert.equal(next.nodes.find((n) => n.id === "a").parentId, "f");
  assert.equal(next.nodes.find((n) => n.id === "under").parentId, null);
  assert.equal(frameAroundSelection(state, [], 40), null);
});

test("framing a selection already inside a frame nests the new frame there", () => {
  const state = { nodes: [frame("outer", 0, 0, 800, 800), box("a", 100, 100, 50, 50, { parentId: "outer" })], connectors: [] };
  const { state: next } = frameAroundSelection(state, ["a"], 10, "f");
  assert.equal(next.nodes.find((n) => n.id === "f").parentId, "outer");
  assert.equal(next.nodes.find((n) => n.id === "a").parentId, "f");
});

test("framing a frame with its contents keeps the contents inside the inner frame", () => {
  const state = { nodes: [frame("in", 0, 0, 200, 200), box("a", 10, 10, 20, 20, { parentId: "in" })], connectors: [] };
  const { state: next } = frameAroundSelection(state, ["in", "a"], 10, "f");
  assert.equal(next.nodes.find((n) => n.id === "in").parentId, "f");
  assert.equal(next.nodes.find((n) => n.id === "a").parentId, "in");
});

test("frame presets resize keeping the corner and are recognised again", () => {
  const f = frame("f", 10, 20, 100, 100);
  const slide = FRAME_PRESETS.find((p) => p.id === "slide-16-9");
  const resized = applyFramePreset(f, slide);
  assert.deepEqual([resized.x, resized.y, resized.w, resized.h], [10, 20, 1280, 720]);
  assert.equal(presetOfFrame(resized).id, "slide-16-9");
  assert.equal(presetOfFrame(f), null);
  assert.ok(FRAME_PRESETS.some((p) => p.id.startsWith("a4")) && FRAME_PRESETS.some((p) => p.id === "phone"));
});

test("nested frames: a move carries grandchildren and every depth", () => {
  const nodes = [
    frame("outer", 0, 0, 900, 900),
    frame("inner", 50, 50, 400, 400, { parentId: "outer" }),
    box("leaf", 100, 100, 50, 50, { parentId: "inner" }),
    box("elsewhere", 2000, 2000),
  ];
  assert.deepEqual([...descendantIds(nodes, ["outer"])].sort(), ["inner", "leaf"]);
  const moved = moveNodesBy({ nodes, connectors: [] }, ["outer"], 10, 5).nodes;
  assert.deepEqual(moved.map((n) => [n.x, n.y]), [[10, 5], [60, 55], [110, 105], [2000, 2000]]);
  const viaFrameMove = applyFrameMove({ nodes, connectors: [] }, "outer", 10, 5).nodes;
  assert.deepEqual(viaFrameMove.map((n) => [n.x, n.y]), moved.map((n) => [n.x, n.y]));
});

test("a frame cycle in the data cannot hang a move", () => {
  const nodes = [frame("a", 0, 0, 10, 10, { parentId: "b" }), frame("b", 0, 0, 10, 10, { parentId: "a" })];
  assert.equal(moveNodesBy({ nodes, connectors: [] }, ["a"], 1, 1).nodes.length, 2);
});

test("a dragged frame nests in the smallest frame that wholly contains it, never its own descendant", () => {
  const nodes = [
    frame("big", 0, 0, 1000, 1000),
    frame("mid", 100, 100, 500, 500),
    frame("small", 150, 150, 100, 100),
    frame("child", 160, 160, 20, 20, { parentId: "small" }),
  ];
  assert.equal(enclosingContainerId(nodes[2], nodes), "mid");
  assert.equal(enclosingContainerId(nodes[1], nodes), "big");
  assert.equal(enclosingContainerId(nodes[0], nodes), null);
  assert.equal(enclosingContainerId(nodes[2], [...nodes.slice(0, 3), { ...nodes[3] }]), "mid");
  const after = renestFrames({ nodes, connectors: [] }, ["small", "mid"]);
  assert.equal(after.nodes.find((n) => n.id === "small").parentId, "mid");
  assert.equal(after.nodes.find((n) => n.id === "mid").parentId, "big");
  assert.equal(renestFrames(after, ["small", "mid"]), after, "settled nesting changes nothing");
});

test("a dragged frame keeps its parent while the parent holds its center, and still nests deeper inside it", () => {
  const nodes = [
    frame("outer", 0, 0, 1000, 1000),
    frame("inner", 500, 500, 400, 400, { parentId: "outer" }),
    frame("edge", -100, 100, 300, 200, { parentId: "outer" }),
    frame("moved", 550, 550, 100, 100, { parentId: "outer" }),
  ];
  assert.equal(enclosingContainerId(nodes[2], nodes), "outer");
  assert.equal(enclosingContainerId({ ...nodes[2], x: -200 }, nodes), null);
  assert.equal(enclosingContainerId(nodes[3], nodes), "inner");
});

test("dates in a duplicated frame title move on a day", () => {
  assert.equal(incrementDates("Standup 2026-03-31"), "Standup 2026-04-01");
  assert.equal(incrementDates("Sprint review 2026-12-31"), "Sprint review 2027-01-01");
  assert.equal(incrementDates("Notes Oct 30"), "Notes Oct 31");
  assert.equal(incrementDates("Notes Oct 31"), "Notes Nov 1");
  assert.equal(incrementDates("October 31, 2026"), "November 1, 2026");
  assert.equal(incrementDates("31 Dec 2026"), "1 Jan 2027");
  assert.equal(incrementDates("Monday plan"), "Tuesday plan");
  assert.equal(incrementDates("Sunday"), "Monday");
  assert.equal(incrementDates("Roadmap"), "Roadmap");
  assert.equal(incrementDates(""), "");
});

test("a date without a year counts in a common year and two overlapping dates move on once", () => {
  assert.equal(incrementDates("Review Feb 28"), "Review Mar 1");
  assert.equal(incrementDates("Review Feb 29"), "Review Mar 1");
  assert.equal(incrementDates("28 Feb"), "1 Mar");
  assert.equal(incrementDates("Feb 28, 2028"), "Feb 29, 2028");
  assert.equal(incrementDates("Feb 29, 2026"), "Feb 29, 2026");
  assert.equal(incrementDates("Apr 31"), "Apr 31");
  assert.equal(incrementDates("2026-02-30"), "2026-02-30");
  assert.equal(incrementDates("3 Mar 5"), "4 Mar 5");
  assert.equal(incrementDates("Mar 3 and 2026-01-31"), "Mar 4 and 2026-02-01");
});

test("duplicated frames are renamed, other clones are not", () => {
  const sources = [frame("f", 0, 0, 10, 10, { name: "Day 2026-01-01" }), box("b", 0, 0)];
  const clones = [{ ...sources[0], id: "f2" }, { ...sources[1], id: "b2" }];
  const out = renameDuplicatedFrames(clones, new Map([["f", "f2"], ["b", "b2"]]), sources);
  assert.equal(out[0].name, "Day 2026-01-02");
  assert.equal(out[1], clones[1]);
});

test("paste into frames keeps the offsets from the copied frame in every selected frame", () => {
  const nodes = [frame("src", 100, 100, 500, 500), box("a", 130, 150, 50, 50, { parentId: "src" })];
  const origin = copyOrigin([nodes[1]], nodes);
  assert.deepEqual(origin, { x: 100, y: 100 });
  const destinations = pasteDestinations([frame("d1", 1000, 0, 400, 400), frame("d2", 0, 2000, 400, 400)], origin);
  assert.deepEqual(destinations, [{ dx: 900, dy: -100, parentId: "d1" }, { dx: -100, dy: 1900, parentId: "d2" }]);
  assert.deepEqual(copyOrigin([box("x", 30, 40), box("y", 90, 90)], [box("x", 30, 40), box("y", 90, 90)]), { x: 30, y: 40 });
});

test("a frame holds what was copied when it, or anything inside it, was copied", () => {
  const nodes = [frame("f", 0, 0, 400, 400), frame("g", 0, 0, 100, 100, { parentId: "f" }), box("a", 10, 10, 50, 50, { parentId: "g" }), frame("other", 900, 0, 100, 100)];
  assert.equal(holdsCopied(nodes[0], [nodes[0]], nodes), true);
  assert.equal(holdsCopied(nodes[0], [nodes[2]], nodes), true);
  assert.equal(holdsCopied(nodes[3], [nodes[2]], nodes), false);
});

test("hidden frames keep their place, size and z-order through an edit by someone who cannot manage them", () => {
  const secret = frame("secret", 100, 100, 300, 300, { hidden: true });
  const before = { nodes: [box("a", 0, 0), secret, box("b", 0, 0)], connectors: [] };
  const after = { nodes: [box("a", 5, 5), box("b", 0, 0, 50, 50, { parentId: "secret" }), frame("new", 0, 0, 10, 10, { hidden: true })], connectors: [] };
  const kept = keepHiddenFrames(before, after);
  assert.deepEqual(kept.nodes.map((n) => n.id), ["a", "secret", "b", "new"]);
  assert.equal(kept.nodes[1], secret);
  assert.equal(kept.nodes[2].parentId, null);
  assert.equal("hidden" in kept.nodes[3], false);
  const plain = { nodes: [box("a", 0, 0)], connectors: [] };
  assert.equal(keepHiddenFrames(plain, plain), plain);
});

test("a synced copy node keeps the frame's size and points at the source", async () => {
  const { syncedNodeFor } = await import("./frames");
  const node = syncedNodeFor("b1", { id: "f1", name: "Scene", w: 400, h: 200 }, { x: 0, y: 0 }, "n1");
  assert.deepEqual([node.type, node.x, node.y, node.sourceBoardId, node.sourceNodeId], ["synced", -200, -100, "b1", "f1"]);
});

test("moving a frame leaves a locked nested frame in place together with its contents", () => {
  const nodes = [
    frame("outer", 0, 0, 800, 600),
    frame("locked", 50, 50, 300, 300, { parentId: "outer", locked: true }),
    box("inLocked", 60, 60, 50, 50, { parentId: "locked" }),
    box("loose", 500, 500, 50, 50, { parentId: "outer" }),
  ];
  const at = Object.fromEntries(moveNodesBy({ nodes, connectors: [] }, ["outer"], 100, 0).nodes.map((n) => [n.id, n.x]));
  assert.deepEqual(at, { outer: 100, locked: 50, inLocked: 60, loose: 600 });
});

test("framing a selection leaves locked objects where they belong", () => {
  const state = { nodes: [box("a", 100, 100), box("b", 300, 100, 50, 50, { locked: true })], connectors: [] };
  const { state: next } = frameAroundSelection(state, ["a", "b"], 10, "f");
  assert.equal(next.nodes.find((n) => n.id === "a").parentId, "f");
  assert.equal(next.nodes.find((n) => n.id === "b").parentId, null);
});
