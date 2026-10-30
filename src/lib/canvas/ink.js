/**
 * Freehand ink: pen and highlighter strokes as `ink` nodes, plus the pure geometry the eraser and the
 * smart-drawing recognizer share. A stroke is one node, so it moves, resizes, groups, copies, saves and
 * merges like every other object. Points are stored flat and rounded (`pts: [x0, y0, x1, y1, ...]`,
 * relative to the node's box as it was drawn, `vw` x `vh`) and simplified before saving, because dense ink
 * eats into the 2 Mi board limit. Everything here reads the data model, never the DOM, so it works for
 * strokes that viewport culling has not mounted.
 */

/** Most points one stroke keeps; longer strokes are simplified harder. */
export const MAX_INK_POINTS = 1500;
/** Most numbers a stored stroke holds (two per point). */
export const MAX_INK_NUMBERS = MAX_INK_POINTS * 2;
const MIN_BOX = 2;

export const PEN_COLORS = ["#ffffff", "#e3c56a", "#6f9bd1"];
export const PEN_WIDTHS = [2, 4, 8];
export const HIGHLIGHTER_COLORS = ["#e3c56a", "#7bd88f", "#f28fb0"];
export const HIGHLIGHTER_WIDTHS = [14, 20, 28];
export const HIGHLIGHTER_OPACITY = 0.4;

function round1(value) {
  return Math.round(value * 10) / 10;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Perpendicular distance from point `p` to the segment `a`-`b`. */
export function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return distance(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/** Ramer-Douglas-Peucker, iterative so a long stroke cannot overflow the stack. */
export function simplifyPoints(points, tolerance) {
  if (points.length <= 2) return points.slice();
  const keep = new Array(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [from, to] = stack.pop();
    let worst = -1;
    let worstDistance = tolerance;
    for (let i = from + 1; i < to; i += 1) {
      const d = distanceToSegment(points[i], points[from], points[to]);
      if (d > worstDistance) {
        worst = i;
        worstDistance = d;
      }
    }
    if (worst !== -1) {
      keep[worst] = true;
      stack.push([from, worst], [worst, to]);
    }
  }
  return points.filter((_, index) => keep[index]);
}

/**
 * A raw pointer trail made compact: simplified at a tolerance that is about a pixel on screen, then
 * again harder if it is still over the per-stroke point cap.
 */
export function simplifyStroke(points, zoom = 1) {
  let tolerance = 1.2 / Math.max(zoom, 0.1);
  let result = simplifyPoints(points, tolerance);
  while (result.length > MAX_INK_POINTS) {
    tolerance *= 1.6;
    result = simplifyPoints(points, tolerance);
  }
  return result;
}

export function pointsBounds(points) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * The `ink` node for a stroke given in world points. `style` carries `stroke`, `strokeWidth` and
 * optionally `highlighter`. The box is the stroke's bounds (at least MIN_BOX across) and points are stored
 * relative to its corner.
 */
export function inkNodeFromPoints(points, style, id = crypto.randomUUID()) {
  const bounds = pointsBounds(points);
  const w = Math.max(round1(bounds.w), MIN_BOX);
  const h = Math.max(round1(bounds.h), MIN_BOX);
  const x = round1(bounds.x);
  const y = round1(bounds.y);
  const pts = [];
  for (const p of points) pts.push(round1(p.x - x), round1(p.y - y));
  const node = {
    id,
    type: "ink",
    x,
    y,
    w,
    h,
    vw: w,
    vh: h,
    pts,
    stroke: style.stroke,
    strokeWidth: style.strokeWidth,
    parentId: null,
    groupId: null,
  };
  if (style.highlighter) {
    node.highlighter = true;
    node.opacity = HIGHLIGHTER_OPACITY;
  }
  return node;
}

/** A node's stroke as world points, following any resize of its box. */
export function inkWorldPoints(node) {
  const pts = Array.isArray(node.pts) ? node.pts : [];
  const sx = node.vw > 0 ? node.w / node.vw : 1;
  const sy = node.vh > 0 ? node.h / node.vh : 1;
  const out = [];
  for (let i = 0; i + 1 < pts.length; i += 2) out.push({ x: node.x + pts[i] * sx, y: node.y + pts[i + 1] * sy });
  return out;
}

/** The SVG path of a stroke in the node's own (vw x vh) coordinate space. */
export function inkPathD(node) {
  const pts = Array.isArray(node.pts) ? node.pts : [];
  if (pts.length < 2) return "";
  if (pts.length === 2) return `M ${pts[0]} ${pts[1]} L ${pts[0]} ${pts[1] + 0.01}`;
  let d = `M ${pts[0]} ${pts[1]}`;
  for (let i = 2; i + 1 < pts.length; i += 2) d += ` L ${pts[i]} ${pts[i + 1]}`;
  return d;
}

/** Closest distance from a world point to the stroke's line (not counting its thickness). */
export function distanceToInk(node, point) {
  const points = inkWorldPoints(node);
  if (points.length === 0) return Infinity;
  if (points.length === 1) return distance(point, points[0]);
  let best = Infinity;
  for (let i = 0; i + 1 < points.length; i += 1) best = Math.min(best, distanceToSegment(point, points[i], points[i + 1]));
  return best;
}

/** Whole-stroke eraser: the ids of ink strokes the eraser circle touches. */
export function inkIdsAt(nodes, point, radius) {
  const ids = [];
  for (const node of nodes) {
    if (node.type !== "ink") continue;
    const reach = radius + (node.strokeWidth ?? 2) / 2;
    const b = { x: node.x - reach, y: node.y - reach, w: node.w + reach * 2, h: node.h + reach * 2 };
    if (point.x < b.x || point.x > b.x + b.w || point.y < b.y || point.y > b.y + b.h) continue;
    if (distanceToInk(node, point) <= reach) ids.push(node.id);
  }
  return ids;
}

/** Inserts points so no segment is longer than `step` (precision erase cuts at the circle, not at a vertex). */
export function densify(points, step) {
  const out = [];
  for (let i = 0; i < points.length; i += 1) {
    out.push(points[i]);
    const next = points[i + 1];
    if (!next) break;
    const length = distance(points[i], next);
    const parts = Math.ceil(length / step);
    for (let part = 1; part < parts; part += 1) {
      const t = part / parts;
      out.push({ x: points[i].x + (next.x - points[i].x) * t, y: points[i].y + (next.y - points[i].y) * t });
    }
  }
  return out;
}

/**
 * Precision eraser: what is left of a stroke after the eraser circle at `point` removes part of it.
 * Returns null when the circle does not touch the stroke, else the pieces as nodes (the first piece keeps
 * the stroke's id; none when nothing is left).
 */
export function eraseInkPart(node, point, radius) {
  if (node.type !== "ink") return null;
  const reach = radius + (node.strokeWidth ?? 2) / 2;
  const original = inkWorldPoints(node);
  if (!original.some((p) => distance(p, point) <= reach) && distanceToInk(node, point) > reach) return null;
  const points = densify(original, Math.max(reach / 2, 1));
  const runs = [];
  let run = [];
  for (const p of points) {
    if (distance(p, point) <= reach) {
      if (run.length) runs.push(run);
      run = [];
    } else {
      run.push(p);
    }
  }
  if (run.length) runs.push(run);
  const pieces = runs.filter((r) => r.length >= 2);
  const style = { stroke: node.stroke, strokeWidth: node.strokeWidth, highlighter: node.highlighter === true };
  return pieces.map((piece, index) => {
    const simplified = simplifyPoints(piece, 0.5);
    const made = inkNodeFromPoints(simplified, style, index === 0 ? node.id : crypto.randomUUID());
    made.parentId = node.parentId ?? null;
    made.groupId = node.groupId ?? null;
    if (node.opacity !== undefined) made.opacity = node.opacity;
    return made;
  });
}

/**
 * The graph after the eraser circle at `point` touches it: whole strokes disappear, or (`precise`) only the
 * touched part of each stroke does. Returns the same object when nothing was hit.
 */
export function eraseAt(state, point, radius, precise) {
  if (!precise) {
    const gone = new Set(inkIdsAt(state.nodes, point, radius));
    if (!gone.size) return state;
    return { ...state, nodes: state.nodes.filter((n) => !gone.has(n.id)) };
  }
  let changed = false;
  const nodes = [];
  for (const node of state.nodes) {
    const pieces = node.type === "ink" ? eraseInkPart(node, point, radius) : null;
    if (pieces === null) {
      nodes.push(node);
      continue;
    }
    changed = true;
    nodes.push(...pieces);
  }
  return changed ? { ...state, nodes } : state;
}

/** Stroke width for a pen: a mouse keeps the preset, a stylus varies with pressure (about 0.5x to 1.5x). */
export function pressureWidth(base, pointerType, pressures) {
  if (pointerType !== "pen" || !pressures.length) return base;
  const average = pressures.reduce((sum, p) => sum + p, 0) / pressures.length;
  return Math.max(1, round1(base * (0.5 + Math.min(1, Math.max(0, average)))));
}
