import test from "node:test";
import assert from "node:assert/strict";
import {
  rectsIntersect,
  normalizeRect,
  computeMarqueeSelection,
  computeAutoscrollDelta,
} from "./marquee-geometry.js";

test("rectsIntersect accurately detects bounding box overlap", () => {
  const card = { left: 100, top: 100, width: 200, height: 200 };

  // Fully overlapping
  assert.equal(
    rectsIntersect(card, { left: 150, top: 150, width: 50, height: 50 }),
    true
  );

  // Partial overlap
  assert.equal(
    rectsIntersect(card, { left: 50, top: 50, width: 100, height: 100 }),
    true
  );

  // Touching edges (non-intersecting boundary)
  assert.equal(
    rectsIntersect(card, { left: 300, top: 100, width: 50, height: 50 }),
    false
  );

  // Disjoint completely
  assert.equal(
    rectsIntersect(card, { left: 500, top: 500, width: 50, height: 50 }),
    false
  );
});

test("normalizeRect normalizes in all four drag directions", () => {
  // 1. Top-Left to Bottom-Right
  const d1 = normalizeRect(10, 20, 110, 120);
  assert.deepEqual(d1, {
    left: 10,
    top: 20,
    width: 100,
    height: 100,
    right: 110,
    bottom: 120,
  });

  // 2. Bottom-Right to Top-Left
  const d2 = normalizeRect(110, 120, 10, 20);
  assert.deepEqual(d2, {
    left: 10,
    top: 20,
    width: 100,
    height: 100,
    right: 110,
    bottom: 120,
  });

  // 3. Top-Right to Bottom-Left
  const d3 = normalizeRect(110, 20, 10, 120);
  assert.deepEqual(d3, {
    left: 10,
    top: 20,
    width: 100,
    height: 100,
    right: 110,
    bottom: 120,
  });

  // 4. Bottom-Left to Top-Right
  const d4 = normalizeRect(10, 120, 110, 20);
  assert.deepEqual(d4, {
    left: 10,
    top: 20,
    width: 100,
    height: 100,
    right: 110,
    bottom: 120,
  });
});

test("computeMarqueeSelection handles normal, shift (add), and alt (subtract) modes", () => {
  const initial = ["card-1", "card-2", "card-3"];
  const hits = ["card-3", "card-4", "card-5"];

  // Normal: replaces selection with hits
  const normal = computeMarqueeSelection(initial, hits, { shift: false, alt: false });
  assert.deepEqual(normal, ["card-3", "card-4", "card-5"]);

  // Shift: adds hits to initial (union, no duplicates)
  const shiftAdded = computeMarqueeSelection(initial, hits, { shift: true, alt: false });
  assert.deepEqual(shiftAdded, ["card-1", "card-2", "card-3", "card-4", "card-5"]);

  // Alt / Option: subtracts hits from initial
  const altSubtracted = computeMarqueeSelection(initial, hits, { shift: false, alt: true });
  assert.deepEqual(altSubtracted, ["card-1", "card-2"]);
});

test("computeAutoscrollDelta computes smooth directional scroll speeds", () => {
  const topEdge = 100;
  const bottomEdge = 600;

  // Inside neutral area — no autoscroll
  assert.equal(computeAutoscrollDelta(350, topEdge, "top"), 0);
  assert.equal(computeAutoscrollDelta(350, bottomEdge, "bottom"), 0);

  // Near top edge (pointer at 110, edge at 100, within 48px band) -> negative delta (scroll up)
  const deltaTop = computeAutoscrollDelta(110, topEdge, "top");
  assert.ok(deltaTop < 0, "Top delta should be negative (scrolling up)");

  // Past top edge (pointer at 80, overshooting) -> max/near-max speed up
  const deltaTopOver = computeAutoscrollDelta(80, topEdge, "top");
  assert.ok(deltaTopOver <= deltaTop, "Overshooting top should scroll at least as fast");

  // Near bottom edge (pointer at 580, edge at 600, within 48px band) -> positive delta (scroll down)
  const deltaBottom = computeAutoscrollDelta(580, bottomEdge, "bottom");
  assert.ok(deltaBottom > 0, "Bottom delta should be positive (scrolling down)");
});
