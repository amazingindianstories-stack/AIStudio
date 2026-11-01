import assert from "node:assert/strict";
import test from "node:test";
import { MAX_SNAP_CANDIDATES, alignmentSnap, gridResizeDelta, measureGaps, snapCandidates, snapMove, snapToGridValue } from "./snapping.js";

const n = (id, x, y, w = 100, h = 100) => ({ id, type: "rect", x, y, w, h });

test("snap candidates skip moving nodes and anything far from the view", () => {
  const state = { nodes: [n("moving", 0, 0), n("near", 300, 0), n("far", 9000, 9000)] };
  const got = snapCandidates(state, new Set(["moving"]), { x: -500, y: -500, w: 2000, h: 2000 }, { x: 0, y: 0 });
  assert.deepEqual(got, [{ x: 300, y: 0, w: 100, h: 100 }]);
});

test("snap candidates are capped to the nearest ones", () => {
  const nodes = Array.from({ length: MAX_SNAP_CANDIDATES + 50 }, (_, i) => n(`n${i}`, i * 10, 0, 5, 5));
  const got = snapCandidates({ nodes }, [], { x: -1e6, y: -1e6, w: 2e6, h: 2e6 }, { x: 0, y: 0 });
  assert.equal(got.length, MAX_SNAP_CANDIDATES);
  assert.equal(got[0].x, 0);
  assert.ok(got.every((b) => b.x < MAX_SNAP_CANDIDATES * 10));
  assert.equal(snapCandidates({ nodes }, [], { x: -1e6, y: -1e6, w: 2e6, h: 2e6 }, { x: 0, y: 0 }, 3).length, 3);
});

test("alignment snaps the nearest edge or center within the threshold and reports guides", () => {
  const target = { x: 200, y: 0, w: 100, h: 100 };
  // Left edge at 197 is 3 from the target's left edge 200.
  const out = alignmentSnap({ x: 197, y: 300, w: 30, h: 50 }, [target], 6);
  assert.equal(out.dx, 3);
  assert.equal(out.dy, null);
  assert.deepEqual(out.guides, [{ axis: "x", at: 200, from: 0, to: 350 }]);
  // Centers: box center y 52 vs target center 50.
  const c = alignmentSnap({ x: 500, y: 27, w: 50, h: 50 }, [target], 6);
  assert.equal(c.dy, -2);
  assert.ok(c.guides.some((g) => g.axis === "y" && g.at === 50));
  // Outside the threshold nothing snaps.
  assert.deepEqual(alignmentSnap({ x: 190, y: 300, w: 50, h: 50 }, [target], 6), { dx: null, dy: null, guides: [] });
});

test("snapMove: a guide wins over the grid per axis, the grid applies otherwise", () => {
  const box = { x: 0, y: 0, w: 50, h: 50 };
  const candidates = [{ x: 103, y: 400, w: 10, h: 10 }];
  // Raw x 101 is near the candidate's left 103 (guide); y 37 has no guide so goes to grid 48.
  const out = snapMove(box, 101, 37, { candidates, threshold: 6, guides: true, grid: 24 });
  assert.equal(out.dx, 103);
  assert.equal(out.dy, 48);
  // Guides off: both axes on the grid.
  const grid = snapMove(box, 101, 37, { candidates, threshold: 6, guides: false, grid: 24 });
  assert.deepEqual([grid.dx, grid.dy], [96, 48]);
  // Neither: the raw delta.
  const raw = snapMove(box, 101, 37, {});
  assert.deepEqual([raw.dx, raw.dy, raw.guides], [101, 37, []]);
});

test("grid snapping places the top-left even from an off-grid start", () => {
  assert.equal(snapToGridValue(35, 24), 24);
  assert.equal(snapToGridValue(37, 24), 48);
  const out = snapMove({ x: 5, y: 5, w: 10, h: 10 }, 20, 0, { grid: 24 });
  assert.equal(5 + out.dx, 24);
  assert.equal(5 + out.dy, 0);
});

test("a grid resize snaps only the dragged edges", () => {
  const start = { x: 10, y: 10, w: 100, h: 100 };
  // East edge at 110 + 25 = 135 -> 144.
  assert.deepEqual(gridResizeDelta(start, "e", 25, 7, 24), { dx: 34, dy: 7 });
  // North-west corner 10 - 3 = 7 -> 0 on both axes.
  assert.deepEqual(gridResizeDelta(start, "nw", -3, -3, 24), { dx: -10, dy: -10 });
  // South edge 110 + 5 = 115 -> 120.
  assert.deepEqual(gridResizeDelta(start, "s", 0, 5, 24), { dx: 0, dy: 10 });
});

test("the ruler measures the gap between separate boxes", () => {
  const a = { x: 0, y: 0, w: 100, h: 100 };
  const b = { x: 150, y: 20, w: 50, h: 50 };
  assert.deepEqual(measureGaps(a, b), [
    { axis: "x", from: 100, to: 150, at: 45, value: 50 },
    { axis: "y", from: 0, to: 20, at: 50, value: 20 },
    { axis: "y", from: 70, to: 100, at: 50, value: 30 },
  ]);
  // Below and to the right: one gap per axis.
  const c = { x: 130, y: 160, w: 10, h: 10 };
  assert.deepEqual(
    measureGaps(a, c).map((m) => [m.axis, m.value]),
    [["x", 30], ["y", 60]]
  );
});

test("the ruler shows nothing for identical boxes", () => {
  const a = { x: 0, y: 0, w: 10, h: 10 };
  assert.deepEqual(measureGaps(a, { ...a }), []);
});
