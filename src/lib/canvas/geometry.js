

import { nodeOutline, pointInPolygon, rayExit } from "./shapes";
import {
  connectorPolyline,
  curvedWaypointsPath,
  nearestTOnPolyline,
  pointAtPolyline,
  polylineEndTangents,
  polylineToPathWithJumps,
  snapPointToAngle,
} from "./connector-routing";

export { snapPointToAngle };

const MIN_NODE_SIZE = 4;
const CONTAINER_NODE_TYPES = new Set(["frame", "swimlane", "diagram"]);

export function isContainerNode(node) {
  return CONTAINER_NODE_TYPES.has(node?.type);
}

// ---- viewport bounds ----

// Reasonable, defensible bounds for "min/max zoom"; the design contract does
// not pin exact numbers. Shared by the store, scroll-zoom, touch gestures and
// the % readout so every path clamps the same way.
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;

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

export function nodeBounds(n) {
  return { x: n.x, y: n.y, w: n.w, h: n.h };
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
  const idSet = new Set(ids);
  for (const node of state.nodes) {
    if (isContainerNode(node) && idSet.has(node.id)) {
      for (const child of state.nodes) {
        if (child.parentId === node.id) idSet.add(child.id);
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

const ERD_HEADER_HEIGHT = 36;
const ERD_FOOTER_HEIGHT = 28;

function erdRowAnchorPoint(node, anchor) {
  if (typeof anchor !== "string" || !anchor.startsWith("row:")) return null;
  const parts = anchor.split(":");
  if (parts.length !== 3) return null;
  const rowId = parts[1];
  const side = parts[2];
  const rows = Array.isArray(node.rows) ? node.rows : [];
  const idx = rows.findIndex((r) => r.id === rowId);
  if (idx === -1) return null;
  const bodyH = Math.max(node.h - ERD_HEADER_HEIGHT - ERD_FOOTER_HEIGHT, rows.length * 28);
  const rowH = rows.length > 0 ? bodyH / rows.length : 28;
  const y = node.y + ERD_HEADER_HEIGHT + (idx + 0.5) * rowH;
  const x = side === "left" ? node.x : node.x + node.w;
  return { x, y: clamp(y, node.y, node.y + node.h) };
}

/**
 * Where an endpoint attaches to `node`. Path shapes attach to their outline:
 * a side anchor is where the ray from the center towards that box side leaves
 * the silhouette, and "auto" is where the ray towards the other end does.
 * ERD nodes also support row-level anchors (`row:<rowId>:left|right`).
 * Every other node keeps its bounding-box anchors unchanged.
 */
export function nodeAnchorPoint(node, anchor, towards) {
  if (node.type === "erd") {
    const rowPt = erdRowAnchorPoint(node, anchor);
    if (rowPt) return rowPt;
  }
  const bounds = nodeBounds(node);
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
  if (!node) return { x: 0, y: 0 }; // dangling ref - caller should have dropped the connector
  if (node.type === "erd") {
    const rowPt = erdRowAnchorPoint(node, ep.anchor);
    if (rowPt) return rowPt;
  }
  const bounds = nodeBounds(node);
  if (!nodeOutline(node)) return anchorPoint(bounds, ep.anchor, boundsCenter(bounds));
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

export function resolveConnectorEnds(c, nodesById) {
  const waypoints = Array.isArray(c.waypoints) && c.waypoints.length > 0 ? c.waypoints : null;
  const fromRough = resolveEndpoint(c.from, nodesById);
  const toRough = resolveEndpoint(c.to, nodesById);
  const fromTarget = waypoints ? waypoints[0] : toRough;
  const toTarget = waypoints ? waypoints[waypoints.length - 1] : fromRough;
  const from = resolveTowards(c.from, fromTarget, nodesById);
  const to = resolveTowards(c.to, toTarget, nodesById);
  return { from, to };
}

/**
 * Sampled or routed polyline points for connector `c`.
 */
export function connectorPoints(c, nodesById) {
  const { from, to } = resolveConnectorEnds(c, nodesById);
  return connectorPolyline(c, from, to, nodesById);
}

/**
 * Point and readable angle along connector `c` at normalized arc-length `t` in [0, 1].
 */
export function connectorPointAt(c, nodesById, t = 0.5) {
  return pointAtPolyline(connectorPoints(c, nodesById), t);
}

/**
 * Nearest normalized arc-length `t` in [0.05, 0.95] along connector `c` to `worldPoint`.
 */
export function connectorNearestT(c, nodesById, worldPoint) {
  return nearestTOnPolyline(connectorPoints(c, nodesById), worldPoint);
}

/**
 * Start and end tangent angles (radians) for connector `c`.
 */
export function connectorEndTangents(c, nodesById) {
  return polylineEndTangents(connectorPoints(c, nodesById));
}

/** SVG path `d` for a connector, resolving "auto" anchors against each
 * other's rough position (nearest-perimeter-point). Deterministic/stable.
 * Supports `curved` (default), `straight` and `orthogonal` (elbow) shapes,
 * custom `waypoints`, and optional `earlierSegments` for line jumps. */
export function connectorPath(
  c,
  nodesById,
  earlierSegments = []
) {
  const { from, to } = resolveConnectorEnds(c, nodesById);
  const shape = c.shape ?? "curved";
  const waypoints = Array.isArray(c.waypoints) && c.waypoints.length > 0 ? c.waypoints : null;

  if (shape === "straight" || shape === "orthogonal") {
    const pts = connectorPolyline(c, from, to, nodesById);
    const jumps = c.lineJumps === false ? [] : earlierSegments;
    return polylineToPathWithJumps(pts, jumps);
  }

  if (waypoints) {
    return curvedWaypointsPath(from, waypoints, to);
  }

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
 * inside their outline, every other node inside its bounding box. */
export function hitTest(state, worldPoint) {
  for (let i = state.nodes.length - 1; i >= 0; i--) {
    const node = state.nodes[i];
    const b = nodeBounds(node);
    if (
      worldPoint.x >= b.x &&
      worldPoint.x <= b.x + b.w &&
      worldPoint.y >= b.y &&
      worldPoint.y <= b.y + b.h
    ) {
      const outline = nodeOutline(node);
      if (!outline || pointInPolygon(worldPoint, outline)) return node.id;
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
