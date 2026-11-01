/**
 * Area selection rules for the marquee and the lasso. Everything here reads
 * the board data (node bounds), never the DOM, so it selects objects culled
 * off-screen too.
 *
 * - Marquee: a plain drag picks every object it touches. A precise marquee
 *   (long press then drag, or the personal `preciseSelection` preference)
 *   picks only objects at least PRECISE_COVERAGE of whose area lies inside it.
 * - Lasso: by default an object is picked when its center is inside the drawn
 *   path, which is how Miro's lasso feels for loosely circled objects. When
 *   precise selection is on, an object is picked only when its whole box is
 *   inside the path: all four corners are inside and no point of the path
 *   enters the box (the path is sampled densely, so this stands in for an
 *   edge-crossing test).
 */
import { nodeBounds } from "./geometry";
import { pointInPolygon } from "./shapes";

/** Share of an object's area a precise marquee must cover. */
export const PRECISE_COVERAGE = 0.9;

/**
 * The share (0..1) of `bounds` that lies inside `rect`. A box with no area
 * (a zero-width line) counts as covered when it lies wholly inside the rect.
 */
export function coverageRatio(bounds, rect) {
  const left = Math.max(bounds.x, rect.x);
  const top = Math.max(bounds.y, rect.y);
  const right = Math.min(bounds.x + bounds.w, rect.x + rect.w);
  const bottom = Math.min(bounds.y + bounds.h, rect.y + rect.h);
  const area = bounds.w * bounds.h;
  if (area <= 0) {
    const inside =
      bounds.x >= rect.x &&
      bounds.y >= rect.y &&
      bounds.x + bounds.w <= rect.x + rect.w &&
      bounds.y + bounds.h <= rect.y + rect.h;
    return inside ? 1 : 0;
  }
  if (right <= left || bottom <= top) return 0;
  return Math.min(1, ((right - left) * (bottom - top)) / area);
}

/** Ids of nodes at least `threshold` covered by the world rect, in board order. */
export function preciseMarqueeHits(state, rect, threshold = PRECISE_COVERAGE) {
  const hits = [];
  for (const node of state.nodes) {
    // A tiny tolerance keeps exactly-90% objects in despite float error.
    if (coverageRatio(nodeBounds(node), rect) >= threshold - 1e-9) hits.push(node.id);
  }
  return hits;
}

function polygonBox(polygon) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of polygon) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

/** Is the whole box inside the (closed) polygon? */
export function boxInsidePolygon(b, polygon) {
  const corners = [
    { x: b.x, y: b.y },
    { x: b.x + b.w, y: b.y },
    { x: b.x + b.w, y: b.y + b.h },
    { x: b.x, y: b.y + b.h },
  ];
  if (!corners.every((p) => pointInPolygon(p, polygon))) return false;
  for (const [x, y] of polygon) {
    if (x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h) return false;
  }
  return true;
}

/**
 * Ids of nodes the lasso `polygon` ([[x, y], ...] in world units, implicitly
 * closed) selects, in board order: center inside, or the whole box inside
 * when `precise`.
 */
export function lassoHits(state, polygon, { precise = false } = {}) {
  if (!polygon || polygon.length < 3) return [];
  const box = polygonBox(polygon);
  const hits = [];
  for (const node of state.nodes) {
    const b = nodeBounds(node);
    // Cheap reject: nothing outside the lasso's own box can be inside it.
    if (b.x + b.w < box.x0 || b.x > box.x1 || b.y + b.h < box.y0 || b.y > box.y1) continue;
    const inside = precise
      ? boxInsidePolygon(b, polygon)
      : pointInPolygon({ x: b.x + b.w / 2, y: b.y + b.h / 2 }, polygon);
    if (inside) hits.push(node.id);
  }
  return hits;
}
