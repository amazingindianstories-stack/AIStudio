/**
 * Snapping while moving or resizing, and the Option/Alt distance ruler.
 * Pure functions over world boxes {x, y, w, h}; the board feeds them boxes
 * from its data (never the DOM), so culled objects still count.
 *
 * Precedence when both are on: per axis, an alignment guide wins; the grid
 * applies on an axis only when no guide caught it. That keeps an object that
 * lines up with a neighbour lined up, and puts it on the grid otherwise.
 */
import { nodeBounds } from "./geometry";

/** How close (in screen pixels) an edge or center must come to snap. */
export const SNAP_DISTANCE_PX = 6;
/** The most neighbours a move compares against, so huge boards stay smooth. */
export const MAX_SNAP_CANDIDATES = 300;

const EPSILON = 1e-6;

function meets(b, rect) {
  return b.x + b.w >= rect.x && b.x <= rect.x + rect.w && b.y + b.h >= rect.y && b.y <= rect.y + rect.h;
}

/**
 * The boxes a move may snap to: nodes meeting `nearRect` (usually the visible
 * area) that are not moving, at most `max` of them, nearest to `focus` first.
 */
export function snapCandidates(state, excludeIds, nearRect, focus, max = MAX_SNAP_CANDIDATES) {
  const exclude = excludeIds instanceof Set ? excludeIds : new Set(excludeIds);
  const boxes = [];
  for (const node of state.nodes) {
    if (exclude.has(node.id)) continue;
    const b = nodeBounds(node);
    if (meets(b, nearRect)) boxes.push(b);
  }
  if (boxes.length <= max) return boxes;
  const distance = (b) => Math.hypot(b.x + b.w / 2 - focus.x, b.y + b.h / 2 - focus.y);
  return boxes
    .map((b) => [distance(b), b])
    .sort((a, b) => a[0] - b[0])
    .slice(0, max)
    .map(([, b]) => b);
}

function linesOf(b, axis) {
  return axis === "x" ? [b.x, b.x + b.w / 2, b.x + b.w] : [b.y, b.y + b.h / 2, b.y + b.h];
}

function bestOffset(box, candidates, axis, threshold) {
  const own = linesOf(box, axis);
  let best = null;
  for (const c of candidates) {
    for (const line of linesOf(c, axis)) {
      for (const mine of own) {
        const d = line - mine;
        if (Math.abs(d) <= threshold && (best === null || Math.abs(d) < Math.abs(best))) best = d;
      }
    }
  }
  return best;
}

function guidesFor(box, candidates, axis) {
  const own = linesOf(box, axis);
  const byLine = new Map();
  for (const c of candidates) {
    for (const line of linesOf(c, axis)) {
      if (!own.some((mine) => Math.abs(line - mine) < EPSILON)) continue;
      const key = Math.round(line * 1000) / 1000;
      const [from, to] =
        axis === "x"
          ? [Math.min(box.y, c.y), Math.max(box.y + box.h, c.y + c.h)]
          : [Math.min(box.x, c.x), Math.max(box.x + box.w, c.x + c.w)];
      const prior = byLine.get(key);
      byLine.set(key, prior ? { ...prior, from: Math.min(prior.from, from), to: Math.max(prior.to, to) } : { axis, at: line, from, to });
    }
  }
  return [...byLine.values()];
}

/**
 * Snaps `box` (already at its raw dragged position) to the nearest edge or
 * center line of `candidates` within `threshold` world units, per axis.
 * Returns the extra {dx, dy} to apply (null on an axis that did not snap)
 * and the guide lines to draw: {axis: "x", at, from, to} is a vertical line
 * at x = at from y = from to y = to; axis "y" is horizontal.
 */
export function alignmentSnap(box, candidates, threshold) {
  const dx = bestOffset(box, candidates, "x", threshold);
  const dy = bestOffset(box, candidates, "y", threshold);
  const snapped = { ...box, x: box.x + (dx ?? 0), y: box.y + (dy ?? 0) };
  const guides = [
    ...(dx !== null ? guidesFor(snapped, candidates, "x") : []),
    ...(dy !== null ? guidesFor(snapped, candidates, "y") : []),
  ];
  return { dx, dy, guides };
}

/** `value` rounded to the nearest multiple of `grid`. */
export function snapToGridValue(value, grid) {
  return Math.round(value / grid) * grid;
}

/**
 * The move delta for a selection whose box starts at `box`, dragged by the
 * raw (dx, dy): snapped to alignment guides when `guides` is on, else (per
 * axis) its top-left snapped to the grid when `grid` is a size.
 * Returns {dx, dy, guides}.
 */
export function snapMove(box, dx, dy, { candidates = [], threshold = 0, guides = false, grid = 0 } = {}) {
  const moved = { ...box, x: box.x + dx, y: box.y + dy };
  const align = guides ? alignmentSnap(moved, candidates, threshold) : { dx: null, dy: null, guides: [] };
  let outX = dx;
  let outY = dy;
  if (align.dx !== null) outX = dx + align.dx;
  else if (grid) outX = snapToGridValue(moved.x, grid) - box.x;
  if (align.dy !== null) outY = dy + align.dy;
  else if (grid) outY = snapToGridValue(moved.y, grid) - box.y;
  return { dx: outX, dy: outY, guides: align.guides };
}

/**
 * The resize delta that puts the dragged edges of `start` (by `handle`: any of
 * n/s/e/w) on the grid. Edges the handle does not drag keep the raw delta.
 */
export function gridResizeDelta(start, handle, dx, dy, grid) {
  let outX = dx;
  let outY = dy;
  if (handle.includes("e")) outX = snapToGridValue(start.x + start.w + dx, grid) - (start.x + start.w);
  else if (handle.includes("w")) outX = snapToGridValue(start.x + dx, grid) - start.x;
  if (handle.includes("s")) outY = snapToGridValue(start.y + start.h + dy, grid) - (start.y + start.h);
  else if (handle.includes("n")) outY = snapToGridValue(start.y + dy, grid) - start.y;
  return { dx: outX, dy: outY };
}

// ---- distance ruler ----

function span(a0, a1, b0, b1) {
  // Measurement lines along one axis between boxes a [a0, a1] and b [b0, b1].
  if (b0 >= a1) return [[a1, b0]];
  if (a0 >= b1) return [[b1, a0]];
  const lines = [];
  if (a0 !== b0) lines.push([Math.min(a0, b0), Math.max(a0, b0)]);
  if (a1 !== b1) lines.push([Math.min(a1, b1), Math.max(a1, b1)]);
  return lines;
}

function crossLine(a0, a1, b0, b1) {
  // Where to draw a measurement: the middle of the shared band, else a's middle.
  const lo = Math.max(a0, b0);
  const hi = Math.min(a1, b1);
  return hi > lo ? (lo + hi) / 2 : (a0 + a1) / 2;
}

/**
 * The distances between the selected box `a` and the hovered box `b`: the gap
 * between them on each axis where they are apart, or how far their matching
 * edges are from each other where they overlap. Each is {axis, from, to, at,
 * value}: axis "x" is a horizontal measurement from x = from to x = to drawn
 * at y = at; axis "y" is vertical.
 */
export function measureGaps(a, b) {
  const out = [];
  const atY = crossLine(a.y, a.y + a.h, b.y, b.y + b.h);
  for (const [from, to] of span(a.x, a.x + a.w, b.x, b.x + b.w)) {
    if (to - from > EPSILON) out.push({ axis: "x", from, to, at: atY, value: Math.round(to - from) });
  }
  const atX = crossLine(a.x, a.x + a.w, b.x, b.x + b.w);
  for (const [from, to] of span(a.y, a.y + a.h, b.y, b.y + b.h)) {
    if (to - from > EPSILON) out.push({ axis: "y", from, to, at: atX, value: Math.round(to - from) });
  }
  return out;
}
