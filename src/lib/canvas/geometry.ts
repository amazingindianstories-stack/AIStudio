/**
 * Pure geometry for the canvas board: coord transforms, bounds, hit-testing,
 * move/resize, frame membership + frame-move propagation, connector endpoint
 * resolution + path. No DOM, no framework — see design.md "Data model" §1/§2
 * for the two hard correctness points this file owns.
 */
import type {
  Anchor,
  CanvasNode,
  CanvasState,
  Connector,
  Endpoint,
  FrameNode,
  Viewport,
} from "./types";

export interface Point {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Not specified by design.md's data model; a standard 8-direction resize
 * handle set, shared with the resize UI (StyleInspector/NodeView handles). */
export type ResizeHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const MIN_NODE_SIZE = 4;

// ---- coord transforms ----

export function worldToScreen(p: Point, vp: Viewport): Point {
  return { x: (p.x - vp.x) * vp.zoom, y: (p.y - vp.y) * vp.zoom };
}

export function screenToWorld(p: Point, vp: Viewport): Point {
  return { x: p.x / vp.zoom + vp.x, y: p.y / vp.zoom + vp.y };
}

// ---- bounds ----

export function nodeBounds(n: CanvasNode): Rect {
  return { x: n.x, y: n.y, w: n.w, h: n.h };
}

/** Does `outer` contain the point `innerCenter`? Used for frame membership. */
export function boundsContain(outer: Rect, innerCenter: Point): boolean {
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
  state: CanvasState,
  ids: string[],
  dx: number,
  dy: number
): CanvasState {
  const idSet = new Set(ids);
  for (const node of state.nodes) {
    if (node.type === "frame" && idSet.has(node.id)) {
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
  state: CanvasState,
  frameId: string,
  dx: number,
  dy: number
): CanvasState {
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
  n: CanvasNode,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  keepAspect: boolean
): CanvasNode {
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
  node: CanvasNode,
  frames: FrameNode[]
): string | null {
  const center = { x: node.x + node.w / 2, y: node.y + node.h / 2 };
  let winner: string | null = null;
  for (const frame of frames) {
    if (frame.id === node.id) continue;
    if (boundsContain(nodeBounds(frame), center)) winner = frame.id;
  }
  return winner;
}

// ---- connectors ----

function anchorPoint(bounds: Rect, anchor: Anchor, towards: Point): Point {
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

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Resolves a single endpoint to world pixels. For an attached endpoint with
 * anchor "auto" this is context-free (no opposite point available) and
 * collapses to the node's center; `connectorPath` below does the fuller
 * nearest-perimeter "auto" resolution using both endpoints.
 */
export function resolveEndpoint(
  ep: Endpoint,
  nodesById: Record<string, CanvasNode>
): Point {
  if (!("nodeId" in ep)) return { x: ep.x, y: ep.y };
  const node = nodesById[ep.nodeId];
  if (!node) return { x: 0, y: 0 }; // dangling ref — caller should have dropped the connector
  const bounds = nodeBounds(node);
  const center = { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 };
  return anchorPoint(bounds, ep.anchor, center);
}

function resolveTowards(
  ep: Endpoint,
  towards: Point,
  nodesById: Record<string, CanvasNode>
): Point {
  if (!("nodeId" in ep)) return { x: ep.x, y: ep.y };
  const node = nodesById[ep.nodeId];
  if (!node) return { x: 0, y: 0 };
  return anchorPoint(nodeBounds(node), ep.anchor, towards);
}

/** SVG path `d` for a connector, resolving "auto" anchors against each
 * other's rough position (nearest-perimeter-point). Deterministic/stable.
 * Renders a gentle quadratic-bezier arc (not a straight line) to match the
 * curved/brace-like connector style. */
export function connectorPath(
  c: Connector,
  nodesById: Record<string, CanvasNode>
): string {
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

/** Top-most node id whose bounding box contains `worldPoint`, or null. */
export function hitTest(state: CanvasState, worldPoint: Point): string | null {
  for (let i = state.nodes.length - 1; i >= 0; i--) {
    const b = nodeBounds(state.nodes[i]);
    if (
      worldPoint.x >= b.x &&
      worldPoint.x <= b.x + b.w &&
      worldPoint.y >= b.y &&
      worldPoint.y <= b.y + b.h
    ) {
      return state.nodes[i].id;
    }
  }
  return null;
}

/** All node ids whose bounds intersect the marquee rect (partial overlap counts). */
export function marqueeHits(state: CanvasState, worldRect: Rect): string[] {
  const hits: string[] = [];
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
