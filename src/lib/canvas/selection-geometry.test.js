import assert from "node:assert/strict";
import test from "node:test";
import { PRECISE_COVERAGE, boxInsidePolygon, coverageRatio, lassoHits, preciseMarqueeHits } from "./selection-geometry.js";

const box = (id, x, y, w = 100, h = 100, extra = {}) => ({ id, type: "sticky", x, y, w, h, ...extra });

test("coverageRatio is the share of the box inside the rect", () => {
  assert.equal(coverageRatio({ x: 0, y: 0, w: 100, h: 100 }, { x: -10, y: -10, w: 200, h: 200 }), 1);
  assert.equal(coverageRatio({ x: 0, y: 0, w: 100, h: 100 }, { x: 50, y: 0, w: 100, h: 100 }), 0.5);
  assert.equal(coverageRatio({ x: 0, y: 0, w: 100, h: 100 }, { x: 200, y: 200, w: 10, h: 10 }), 0);
  // A zero-area box counts only when wholly inside.
  assert.equal(coverageRatio({ x: 5, y: 5, w: 0, h: 50 }, { x: 0, y: 0, w: 100, h: 100 }), 1);
  assert.equal(coverageRatio({ x: 5, y: 5, w: 0, h: 500 }, { x: 0, y: 0, w: 100, h: 100 }), 0);
});

test("a precise marquee picks objects at least 90% covered, including exactly 90%", () => {
  assert.equal(PRECISE_COVERAGE, 0.9);
  const state = { nodes: [box("full", 0, 0), box("ninety", 200, 0), box("eighty", 400, 0), box("far", 2000, 0)] };
  // Rect covers all of "full", x 210..300 of "ninety" (90%), x 420..500 of "eighty" (80%).
  const hits = preciseMarqueeHits(state, { x: -5, y: -5, w: 0, h: 0 });
  assert.deepEqual(hits, []);
  assert.deepEqual(preciseMarqueeHits(state, { x: -5, y: -5, w: 110, h: 110 }), ["full"]);
  assert.deepEqual(preciseMarqueeHits({ nodes: state.nodes.slice(1, 2) }, { x: 210, y: -5, w: 200, h: 110 }), ["ninety"]);
  assert.deepEqual(preciseMarqueeHits({ nodes: state.nodes.slice(2, 3) }, { x: 420, y: -5, w: 200, h: 110 }), []);
});

test("precise coverage uses rotated bounds", () => {
  // A 100x100 square rotated 45 degrees has a ~141 wide box; a 100x100 rect covers about half of it.
  const state = { nodes: [box("r", 0, 0, 100, 100, { rotation: 45 })] };
  assert.deepEqual(preciseMarqueeHits(state, { x: 0, y: 0, w: 100, h: 100 }), []);
  assert.deepEqual(preciseMarqueeHits(state, { x: -30, y: -30, w: 160, h: 160 }), ["r"]);
});

const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

test("the lasso picks objects whose center is inside the path by default", () => {
  const state = { nodes: [box("in", 0, 0), box("half", 150, 0), box("out", 400, 0)] };
  // Path covers x -10..210: "half" spans 150..250, center 200 inside.
  assert.deepEqual(lassoHits(state, square(-10, -10, 210, 110)), ["in", "half"]);
});

test("a precise lasso picks only objects wholly inside the path", () => {
  const state = { nodes: [box("in", 0, 0), box("half", 150, 0)] };
  assert.deepEqual(lassoHits(state, square(-10, -10, 210, 110), { precise: true }), ["in"]);
});

test("a precise lasso rejects a box the path cuts into between its corners", () => {
  // A U shape whose notch pokes into the middle of the box from above.
  const u = [[-10, -10], [40, -10], [40, 60], [60, 60], [60, -10], [110, -10], [110, 110], [-10, 110]];
  const b = { x: 0, y: 0, w: 100, h: 100 };
  assert.equal(boxInsidePolygon(b, u), false);
  assert.equal(boxInsidePolygon(b, square(-10, -10, 110, 110)), true);
});

test("the lasso needs at least three points", () => {
  assert.deepEqual(lassoHits({ nodes: [box("a", 0, 0)] }, [[0, 0], [10, 10]]), []);
  assert.deepEqual(lassoHits({ nodes: [box("a", 0, 0)] }, null), []);
});
