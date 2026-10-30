/**
 * Smart drawing: recognizes a hand-drawn stroke and maps it to an existing board object. Pure geometry on
 * world points, so it is the same for every pointer. A closed outline becomes a rectangle, ellipse, triangle
 * or diamond (a square becomes a sticky note), a straight stroke a line, and a back-and-forth scribble
 * erases what it crosses.
 */
import { pointsBounds, simplifyPoints } from "./ink";

const MIN_SIZE = 24;

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pathLength(points) {
  let total = 0;
  for (let i = 0; i + 1 < points.length; i += 1) total += dist(points[i], points[i + 1]);
  return total;
}

/** How many times the stroke turns back on itself (a sharp reversal of direction). */
export function countReversals(points) {
  const polyline = simplifyPoints(points, 2);
  let reversals = 0;
  for (let i = 1; i + 1 < polyline.length; i += 1) {
    const a = polyline[i - 1];
    const b = polyline[i];
    const c = polyline[i + 1];
    const v1 = { x: b.x - a.x, y: b.y - a.y };
    const v2 = { x: c.x - b.x, y: c.y - b.y };
    const m1 = Math.hypot(v1.x, v1.y);
    const m2 = Math.hypot(v2.x, v2.y);
    if (m1 < 3 || m2 < 3) continue;
    const cos = (v1.x * v2.x + v1.y * v2.y) / (m1 * m2);
    if (cos < -0.5) reversals += 1;
  }
  return reversals;
}

/** Standard deviation of how far the points sit from the box's inscribed ellipse (0 for a perfect ellipse). */
function ellipseDeviation(points, box) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const rx = box.w / 2 || 1;
  const ry = box.h / 2 || 1;
  const radii = points.map((p) => Math.hypot((p.x - cx) / rx, (p.y - cy) / ry));
  const mean = radii.reduce((s, r) => s + r, 0) / radii.length;
  const variance = radii.reduce((s, r) => s + (r - mean) ** 2, 0) / radii.length;
  return Math.sqrt(variance) + Math.abs(mean - 1);
}

function nearBoxCorner(p, box, reach) {
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.w, y: box.y },
    { x: box.x, y: box.y + box.h },
    { x: box.x + box.w, y: box.y + box.h },
  ].some((c) => dist(p, c) <= reach);
}

function nearEdgeMiddle(p, box, reach) {
  return [
    { x: box.x + box.w / 2, y: box.y },
    { x: box.x + box.w, y: box.y + box.h / 2 },
    { x: box.x + box.w / 2, y: box.y + box.h },
    { x: box.x, y: box.y + box.h / 2 },
  ].some((c) => dist(p, c) <= reach);
}

/** Resamples a polyline to evenly spaced points so a sparse stroke weighs like a dense one. */
function resample(points, count) {
  const total = pathLength(points);
  if (total === 0) return points.slice();
  const step = total / count;
  const out = [points[0]];
  let carried = 0;
  for (let i = 0; i + 1 < points.length; i += 1) {
    let a = points[i];
    const b = points[i + 1];
    let segment = dist(a, b);
    while (carried + segment >= step) {
      const t = (step - carried) / segment;
      a = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      out.push(a);
      segment = dist(a, b);
      carried = 0;
    }
    carried += segment;
  }
  return out;
}

/**
 * What a stroke means, or null when it stays as ink:
 * - `{ kind: "erase", points }` for a scribble,
 * - `{ kind: "line", from, to }` for a straight stroke,
 * - `{ kind: "shape", shape, box }` for a closed outline (`shape` is rect, ellipse, triangle or diamond),
 * - `{ kind: "sticky", box }` for a closed, squarish four-corner outline.
 */
export function recognizeStroke(points) {
  if (points.length < 4) return null;
  const box = pointsBounds(points);
  const diagonal = Math.hypot(box.w, box.h);
  const length = pathLength(points);
  if (length < MIN_SIZE) return null;

  if (length > diagonal * 2.6 && countReversals(points) >= 4) return { kind: "erase", points };

  const first = points[0];
  const last = points[points.length - 1];
  const gap = dist(first, last);
  const straight = gap / length;
  if (straight >= 0.92 && length >= MIN_SIZE * 2) return { kind: "line", from: first, to: last };

  if (box.w < MIN_SIZE || box.h < MIN_SIZE) return null;
  if (gap / length > 0.22) return null;

  const even = resample(points, 64);
  const corners = simplifyPoints(even, diagonal * 0.09);
  // Drop the closing duplicate of the start.
  const vertices = dist(corners[0], corners[corners.length - 1]) < diagonal * 0.15 ? corners.slice(0, -1) : corners;
  const reach = diagonal * 0.22;

  // A round outline can simplify to four corners, so test for a circle before reading corners.
  if (ellipseDeviation(even, box) <= 0.16) return { kind: "shape", shape: "ellipse", box };
  if (vertices.length === 3) return { kind: "shape", shape: "triangle", box };
  if (vertices.length === 4) {
    if (vertices.every((p) => nearBoxCorner(p, box, reach))) {
      const ratio = box.w / box.h;
      return ratio > 0.85 && ratio < 1.18 ? { kind: "sticky", box } : { kind: "shape", shape: "rect", box };
    }
    if (vertices.every((p) => nearEdgeMiddle(p, box, reach))) return { kind: "shape", shape: "diamond", box };
  }
  if (vertices.length >= 4 && vertices.length <= 5 && vertices.filter((p) => nearBoxCorner(p, box, reach)).length >= 3) {
    return { kind: "shape", shape: "rect", box };
  }
  return null;
}

/** Ids of the objects a scribble crosses: those with at least `minHits` scribble points inside (frames are never erased). */
export function scribbleTargets(nodes, points, minHits = 3) {
  const hits = [];
  for (const node of nodes) {
    if (node.type === "frame") continue;
    let count = 0;
    if (node.type === "ink") {
      // A stroke counts when the scribble runs along it.
      const line = pointsBounds(points);
      const overlap = node.x < line.x + line.w && node.x + node.w > line.x && node.y < line.y + line.h && node.y + node.h > line.y;
      if (!overlap) continue;
      for (const p of points) {
        const reach = (node.strokeWidth ?? 2) / 2 + 8;
        if (p.x >= node.x - reach && p.x <= node.x + node.w + reach && p.y >= node.y - reach && p.y <= node.y + node.h + reach) count += 1;
      }
    } else {
      for (const p of points) {
        if (p.x >= node.x && p.x <= node.x + node.w && p.y >= node.y && p.y <= node.y + node.h) count += 1;
      }
    }
    if (count >= minHits) hits.push(node.id);
  }
  return hits;
}
