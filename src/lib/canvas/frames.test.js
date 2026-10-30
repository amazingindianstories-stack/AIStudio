import test from "node:test";
import assert from "node:assert/strict";
import {
  FRAME_PRESETS, applyFramePreset, copyOrigin, enclosingFrameId, frameAroundSelection, incrementDates, pasteDestinations,
  presetOfFrame, renameDuplicatedFrames, renestFrames,
} from "./frames.js";
import { applyFrameMove, descendantIds, moveNodesBy } from "./geometry.js";

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
  assert.equal(enclosingFrameId(nodes[2], nodes), "mid");
  assert.equal(enclosingFrameId(nodes[1], nodes), "big");
  assert.equal(enclosingFrameId(nodes[0], nodes), null);
  assert.equal(enclosingFrameId(nodes[2], [...nodes.slice(0, 3), { ...nodes[3] }]), "mid");
  const after = renestFrames({ nodes, connectors: [] }, ["small", "mid"]);
  assert.equal(after.nodes.find((n) => n.id === "small").parentId, "mid");
  assert.equal(after.nodes.find((n) => n.id === "mid").parentId, "big");
  assert.equal(renestFrames(after, ["small", "mid"]), after, "settled nesting changes nothing");
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

test("a synced copy node keeps the frame's size and points at the source", async () => {
  const { syncedNodeFor } = await import("./frames");
  const node = syncedNodeFor("b1", { id: "f1", name: "Scene", w: 400, h: 200 }, { x: 0, y: 0 }, "n1");
  assert.deepEqual([node.type, node.x, node.y, node.sourceBoardId, node.sourceNodeId], ["synced", -200, -100, "b1", "f1"]);
});
