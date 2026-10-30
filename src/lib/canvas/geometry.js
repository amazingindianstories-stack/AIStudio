

import { nodeOutline, pointInPolygon, rayExit } from "./shapes";
import { lockedIdSet } from "./locks";

export const MIN_NODE_SIZE = 4;

// ---- viewport bounds ----

// Reasonable, defensible bounds for "min/max zoom"; the design contract does
// not pin exact numbers. Shared by the store, scroll-zoom, touch gestures and
// the % readout so every path clamps the same way.
export const MIN_ZOOM = 0.1;
// 2000%, as in Miro.
export const MAX_ZOOM = 20;

export function clampZoom(zoom) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

// ---- coord transforms ----

export function worldToScreen(p, vp) {
  return { x: (p.x - vp.x) * vp.zoom, y: (p.y - vp.y) * vp.zoom };
}

export function screenToWorld(p, vp) {
  return { x: p.x / vp.zoom + vp.x, y: p.y / vp.zoom + vp.y };
}

// ---- bounds ----

/**
 * The world axis-aligned box a node covers. A rotated node covers the box
 * around its four rotated corners, so culling, marquee, fit and frames all
 * see what is drawn.
 */
export function nodeBounds(n) {
  const deg = nodeRotation(n);
  if (!deg) return { x: n.x, y: n.y, w: n.w, h: n.h };
  const corners = nodeCorners(n);
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** The union box {x, y, w, h} of `boxes`, or null when there are none. */
export function unionBounds(boxes) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  if (!Number.isFinite(x0)) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ---- rotation ----
// `rotation` is degrees clockwise about the node's center (0 < r < 360,
// omitted when 0). A node's "local frame" is its unrotated box in world
// units: rotating a local point about the center gives its world position.

/** An angle as stored on a node: in [0, 360), rounded to 0.01 degree, 0 when (nearly) upright. */
export function normalizeRotation(deg) {
  if (!Number.isFinite(deg)) return 0;
  const r = Math.round((((deg % 360) + 360) % 360) * 100) / 100;
  return r >= 360 || r <= 0 ? 0 : r;
}

/** The node's rotation in degrees, 0 when it has none. */
export function nodeRotation(n) {
  const r = n?.rotation;
  return Number.isFinite(r) && r > 0 && r < 360 ? r : 0;
}

/** The node with `deg` as its rotation; the field is dropped when upright. */
export function withRotation(n, deg) {
  const r = normalizeRotation(deg);
  if (r === nodeRotation(n) && (r !== 0 || !("rotation" in n))) return n;
  const next = { ...n };
  if (r) next.rotation = r;
  else delete next.rotation;
  return next;
}

export function nodeCenter(n) {
  return { x: n.x + n.w / 2, y: n.y + n.h / 2 };
}

/** `p` rotated `deg` degrees clockwise (screen axes, y down) about `center`. */
export function rotatePoint(p, center, deg) {
  if (!deg) return { x: p.x, y: p.y };
  const a = (deg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
}

/** A world point in the node's local (unrotated) frame. */
export function toNodeLocal(n, p) {
  return rotatePoint(p, nodeCenter(n), -nodeRotation(n));
}

/** A local-frame point of the node in world space. */
export function fromNodeLocal(n, p) {
  return rotatePoint(p, nodeCenter(n), nodeRotation(n));
}

/** The node's corners in world space, clockwise from its local top-left. */
export function nodeCorners(n) {
  return [
    { x: n.x, y: n.y },
    { x: n.x + n.w, y: n.y },
    { x: n.x + n.w, y: n.y + n.h },
    { x: n.x, y: n.y + n.h },
  ].map((p) => fromNodeLocal(n, p));
}

/**
 * The node at size w x h, placed so the point at fraction (fx, fy) of its
 * box (0,0 the local top-left, 1,1 the local bottom-right) stays where it is
 * in world space. Unrotated nodes keep plain arithmetic, so nothing drifts.
 */
export function resizeAnchored(n, w, h, fx = 0, fy = 0) {
  const deg = nodeRotation(n);
  if (!deg) return { ...n, x: n.x + fx * (n.w - w), y: n.y + fy * (n.h - h), w, h };
  const fixed = fromNodeLocal(n, { x: n.x + fx * n.w, y: n.y + fy * n.h });
  const offset = rotatePoint({ x: (fx - 0.5) * w, y: (fy - 0.5) * h }, { x: 0, y: 0 }, deg);
  const cx = fixed.x - offset.x;
  const cy = fixed.y - offset.y;
  return { ...n, x: cx - w / 2, y: cy - h / 2, w, h };
}

/** Does `outer` contain the point `innerCenter`? Used for frame membership. */
export function boundsContain(outer, innerCenter) {
  return (
    innerCenter.x >= outer.x &&
    innerCenter.x <= outer.x + outer.w &&
    innerCenter.y >= outer.y &&
    innerCenter.y <= outer.y + outer.h
  );
}

// ---- move ----

/**
 * Moves the given node ids by (dx,dy). If a selected id is a frame, its
 * children (nodes with parentId === frame.id) move by the same delta too,
 * so a multi-select drag that includes a frame carries its contents — a
 * child that's ALSO directly selected only ever moves once (Set dedupe).
 */
export function moveNodesBy(
  state,
  ids,
  dx,
  dy
) {
  // Locked objects stay put, including the locked children of a moved frame.
  const locked = lockedIdSet(state);
  const idSet = new Set(ids.filter((id) => !locked.has(id)));
  for (const node of state.nodes) {
    if (node.type === "frame" && idSet.has(node.id)) {
      for (const child of state.nodes) {
        if (child.parentId === node.id && !locked.has(child.id)) idSet.add(child.id);
      }
    }
  }
  const nodes = state.nodes.map((n) =>
    idSet.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n
  );
  return { ...state, nodes };
}

/** Shifts a frame AND every direct descendant (parentId === frameId) by the
 * same delta — the pure fn moving a frame's contents together (AC #6). */
export function applyFrameMove(
  state,
  frameId,
  dx,
  dy
) {
  const nodes = state.nodes.map((n) =>
    n.id === frameId || n.parentId === frameId
      ? { ...n, x: n.x + dx, y: n.y + dy }
      : n
  );
  return { ...state, nodes };
}

// ---- resize ----

/**
 * Applies a resize delta (dx,dy) to `n` for the given handle (the caller
 * decides whether dx/dy is per-event incremental or cumulative-since-start;
 * this function is agnostic — it just resizes `n` by exactly the delta
 * given). `keepAspect` preserves `n`'s current w/h ratio: for corner
 * handles the axis that moved proportionally more wins and the other axis
 * is derived from it (anchoring the opposite corner); for edge handles the
 * perpendicular axis is derived from the ratio too.
 */
export function resizeNode(
  n,
  handle,
  dx,
  dy,
  keepAspect
) {
  const deg = nodeRotation(n);
  if (deg) {
    // A rotated node resizes in its own frame: the pointer delta is turned
    // into local axes, and the handle opposite the dragged one stays put in
    // world space so the object does not drift.
    const local = rotatePoint({ x: dx, y: dy }, { x: 0, y: 0 }, -deg);
    const upright = resizeNode({ ...n, rotation: 0 }, handle, local.x, local.y, keepAspect);
    const fx = handle.includes("w") ? 1 : 0;
    const fy = handle.includes("n") ? 1 : 0;
    return resizeAnchored(n, upright.w, upright.h, fx, fy);
  }
  const { x, y, w, h } = n;
  const e = handle.includes("e");
  const wSide = handle.includes("w");
  const s = handle.includes("s");
  const nSide = handle.includes("n");

  let newX = x;
  let newY = y;
  let newW = w;
  let newH = h;

  if (e) newW = w + dx;
  if (wSide) {
    newW = w - dx;
    newX = x + dx;
  }
  if (s) newH = h + dy;
  if (nSide) {
    newH = h - dy;
    newY = y + dy;
  }

  if (keepAspect && w > 0 && h > 0) {
    const isCorner = (e || wSide) && (s || nSide);
    if (isCorner) {
      const scaleW = newW / w;
      const scaleH = newH / h;
      const scale = Math.abs(scaleW - 1) > Math.abs(scaleH - 1) ? scaleW : scaleH;
      newW = w * scale;
      newH = h * scale;
      if (wSide) newX = x + (w - newW);
      if (nSide) newY = y + (h - newH);
    } else if (e || wSide) {
      const ratio = w / h;
      newH = newW / ratio;
      // edge handle only moves its own axis; height grows/shrinks centered
      // on the unchanged edge (top stays put unless the n handle is set).
    } else if (s || nSide) {
      const ratio = w / h;
      newW = newH * ratio;
    }
  }

  newW = Math.max(MIN_NODE_SIZE, newW);
  newH = Math.max(MIN_NODE_SIZE, newH);

  return { ...n, x: newX, y: newY, w: newW, h: newH };
}

// ---- frame membership ----

/**
 * The front-most (highest z-index) frame whose bounds contain `node`'s
 * center, or null. `frames` must be passed in z-order (as they appear in
 * CanvasState.nodes) — later entries win ties, matching "front-most wins".
 */
export function computeFrameMembership(
  node,
  frames
) {
  const center = { x: node.x + node.w / 2, y: node.y + node.h / 2 };
  let winner = null;
  for (const frame of frames) {
    if (frame.id === node.id) continue;
    if (boundsContain(nodeBounds(frame), center)) winner = frame.id;
  }
  return winner;
}

// ---- connectors ----

function anchorPoint(bounds, anchor, towards) {
  const cx = bounds.x + bounds.w / 2;
  const cy = bounds.y + bounds.h / 2;
  switch (anchor) {
    case "top":
      return { x: cx, y: bounds.y };
    case "bottom":
      return { x: cx, y: bounds.y + bounds.h };
    case "left":
      return { x: bounds.x, y: cy };
    case "right":
      return { x: bounds.x + bounds.w, y: cy };
    case "center":
      return { x: cx, y: cy };
    case "auto":
    default: {
      // Nearest point on the bounding-box perimeter to `towards`. With
      // towards === the node's own center (resolveEndpoint's context-free
      // case) this collapses to the center itself.
      const dx = towards.x - cx;
      const dy = towards.y - cy;
      const w = bounds.w || 1;
      const h = bounds.h || 1;
      if (Math.abs(dx) / w > Math.abs(dy) / h) {
        return {
          x: dx > 0 ? bounds.x + bounds.w : bounds.x,
          y: clamp(towards.y, bounds.y, bounds.y + bounds.h),
        };
      }
      return {
        x: clamp(towards.x, bounds.x, bounds.x + bounds.w),
        y: dy > 0 ? bounds.y + bounds.h : bounds.y,
      };
    }
  }
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

const ANCHOR_DIRECTIONS = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

/**
 * Where an endpoint attaches to `node`. Path shapes attach to their outline:
 * a side anchor is where the ray from the center towards that box side leaves
 * the silhouette, and "auto" is where the ray towards the other end does.
 * Every other node keeps its bounding-box anchors unchanged.
 */
export function nodeAnchorPoint(node, anchor, towards) {
  // A rotated node attaches where its rotated shape does: resolve in the
  // node's own frame, then turn the point back into world space.
  if (nodeRotation(node)) {
    const local = uprightAnchorPoint(node, anchor, towards && toNodeLocal(node, towards));
    return fromNodeLocal(node, local);
  }
  return uprightAnchorPoint(node, anchor, towards);
}

function uprightBounds(n) {
  return { x: n.x, y: n.y, w: n.w, h: n.h };
}

function uprightAnchorPoint(node, anchor, towards) {
  const bounds = uprightBounds(node);
  const outline = nodeOutline(node);
  if (!outline || anchor === "center") return anchorPoint(bounds, anchor, towards ?? boundsCenter(bounds));
  const center = boundsCenter(bounds);
  const direction = ANCHOR_DIRECTIONS[anchor];
  const target = direction
    ? { x: center.x + direction.x * bounds.w, y: center.y + direction.y * bounds.h }
    : towards;
  if (!target) return center;
  return rayExit(outline, center, target) ?? anchorPoint(bounds, anchor, target);
}

function boundsCenter(b) {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/**
 * Resolves a single endpoint to world pixels. For an attached endpoint with
 * anchor "auto" this is context-free (no opposite point available) and
 * collapses to the node's center; `connectorPath` below does the fuller
 * nearest-perimeter "auto" resolution using both endpoints.
 */
export function resolveEndpoint(
  ep,
  nodesById
) {
  if (!("nodeId" in ep)) return { x: ep.x, y: ep.y };
  const node = nodesById[ep.nodeId];
  if (!node) return { x: 0, y: 0 }; // dangling ref — caller should have dropped the connector
  const bounds = uprightBounds(node);
  if (!nodeOutline(node)) return fromNodeLocal(node, anchorPoint(bounds, ep.anchor, boundsCenter(bounds)));
  // A path shape's "auto" has no opposite point here, so it is the center.
  return ep.anchor === "auto" ? boundsCenter(bounds) : nodeAnchorPoint(node, ep.anchor);
}

function resolveTowards(
  ep,
  towards,
  nodesById
) {
  if (!("nodeId" in ep)) return { x: ep.x, y: ep.y };
  const node = nodesById[ep.nodeId];
  if (!node) return { x: 0, y: 0 };
  return nodeAnchorPoint(node, ep.anchor, towards);
}

/** SVG path `d` for a connector, resolving "auto" anchors against each
 * other's rough position (nearest-perimeter-point). Deterministic/stable.
 * Renders a gentle quadratic-bezier arc (not a straight line) to match the
 * curved/brace-like connector style. */
export function connectorPath(
  c,
  nodesById
) {
  const fromRough = resolveEndpoint(c.from, nodesById);
  const toRough = resolveEndpoint(c.to, nodesById);
  const from = resolveTowards(c.from, toRough, nodesById);
  const to = resolveTowards(c.to, fromRough, nodesById);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  const bow = Math.min(dist * 0.25, 60);
  // Perpendicular to the from->to vector, normalized.
  const nx = -dy / dist;
  const ny = dx / dist;
  const ctrlX = midX + nx * bow;
  const ctrlY = midY + ny * bow;
  return `M ${from.x} ${from.y} Q ${ctrlX} ${ctrlY} ${to.x} ${to.y}`;
}

// ---- hit testing ----

/** Top-most node id under `worldPoint`, or null: path shapes count only
 * inside their outline, every other node inside its (rotated) box. */
export function hitTest(state, worldPoint) {
  for (let i = state.nodes.length - 1; i >= 0; i--) {
    const node = state.nodes[i];
    // Tested in the node's own frame, so a rotated node is hit inside its
    // rotated box (or outline), not its larger axis-aligned bounds.
    const p = toNodeLocal(node, worldPoint);
    if (
      p.x >= node.x &&
      p.x <= node.x + node.w &&
      p.y >= node.y &&
      p.y <= node.y + node.h
    ) {
      const outline = nodeOutline(node);
      if (!outline || pointInPolygon(p, outline)) return node.id;
    }
  }
  return null;
}

/** All node ids whose bounds intersect the marquee rect (partial overlap counts). */
export function marqueeHits(state, worldRect) {
  const hits = [];
  for (const n of state.nodes) {
    const b = nodeBounds(n);
    const overlap =
      b.x < worldRect.x + worldRect.w &&
      b.x + b.w > worldRect.x &&
      b.y < worldRect.y + worldRect.h &&
      b.y + b.h > worldRect.y;
    if (overlap) hits.push(n.id);
  }
  return hits;
}
