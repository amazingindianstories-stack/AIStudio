/**
 * Rotating and precisely sizing board objects (pure functions over the board
 * graph). Frames do not rotate, as in Miro; connectors are not nodes. Locked
 * objects are left as they are. The store slice in transform-actions.js
 * commits these as single undo steps.
 */
import {
  MIN_NODE_SIZE,
  computeFrameMembership,
  nodeBounds,
  nodeCenter,
  nodeRotation,
  normalizeRotation,
  resizeAnchored,
  rotatePoint,
  unionBounds,
  withRotation,
} from "./geometry";
import { lockedIdSet } from "./locks";

/** Shift-drag on the rotation handle snaps to this step. */
export const ROTATE_SNAP_DEG = 15;

export function canRotateNode(node) {
  return !!node && node.type !== "frame";
}

/** The nodes `ids` names that a rotation changes: present, unlocked and not frames, in board order. */
export function rotationTargets(state, ids) {
  const wanted = new Set(ids);
  const locked = lockedIdSet(state);
  return state.nodes.filter((n) => wanted.has(n.id) && !locked.has(n.id) && canRotateNode(n));
}

/** The nodes `ids` names that a size change applies to: present and unlocked, in board order. */
export function sizeTargets(state, ids) {
  const wanted = new Set(ids);
  const locked = lockedIdSet(state);
  return state.nodes.filter((n) => wanted.has(n.id) && !locked.has(n.id));
}

/**
 * The center of the box around `nodes` (as drawn, rotation included), or null
 * for none. A single node's is its own center, so it turns in place exactly.
 */
export function groupCenter(nodes) {
  if (nodes.length === 1) return nodeCenter(nodes[0]);
  const box = unionBounds(nodes.map(nodeBounds));
  return box && { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

/** Degrees clockwise from straight up of the direction from `center` to `p` (y points down). */
export function pointerAngle(center, p) {
  return (Math.atan2(p.x - center.x, -(p.y - center.y)) * 180) / Math.PI;
}

export function snapAngle(deg, step = ROTATE_SNAP_DEG) {
  return Math.round(deg / step) * step;
}

/**
 * The rotation a handle drag has made so far. A single object snaps its
 * resulting angle to the step (so it lands on 0, 15, 30...); a group snaps
 * the turn it has made, since its members start at different angles.
 */
export function rotationDragDelta(startAngle, angle, { snap = false, startRotation = null } = {}) {
  let delta = angle - startAngle;
  if (!snap) return delta;
  if (startRotation != null) return snapAngle(startRotation + delta) - startRotation;
  return snapAngle(delta);
}

/**
 * Turns the rotatable nodes among `ids` by `deltaDeg` clockwise about
 * `center` (default: the center of their box): each node's center orbits
 * the pivot and its own rotation grows by the same angle. A single node
 * turned about its own center stays in place. Moved nodes re-take whichever
 * frame their center now sits in, as a drag does.
 */
export function rotateNodesAbout(state, ids, deltaDeg, center = null) {
  const targets = rotationTargets(state, ids);
  if (!targets.length || !normalizeRotation(deltaDeg)) return state;
  const pivot = center ?? groupCenter(targets);
  const byId = new Map(targets.map((n) => [n.id, n]));
  const frames = state.nodes.filter((n) => n.type === "frame");
  let changed = false;
  const nodes = state.nodes.map((n) => {
    if (!byId.has(n.id)) return n;
    const c = rotatePoint(nodeCenter(n), pivot, deltaDeg);
    let next = withRotation({ ...n, x: c.x - n.w / 2, y: c.y - n.h / 2 }, nodeRotation(n) + deltaDeg);
    if (next.x !== n.x || next.y !== n.y) {
      const parentId = computeFrameMembership(next, frames);
      if (parentId !== (n.parentId ?? null)) next = { ...next, parentId };
    }
    changed = true;
    return next;
  });
  return changed ? { ...state, nodes } : state;
}

/** Sets each rotatable node among `ids` to `deg` about its own center. */
export function setNodesRotation(state, ids, deg) {
  const targets = new Set(rotationTargets(state, ids).map((n) => n.id));
  let changed = false;
  const nodes = state.nodes.map((n) => {
    if (!targets.has(n.id)) return n;
    const next = withRotation(n, deg);
    if (next !== n) changed = true;
    return next;
  });
  return changed ? { ...state, nodes } : state;
}

/** A size typed into the inspector: a whole number of world pixels, at least the minimum size. */
export function cleanSize(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  return Math.max(MIN_NODE_SIZE, Math.round(v));
}

/** Whether a size change on this node keeps its proportions (images with the aspect lock on). */
export function keepsAspect(node) {
  return node.type === "image" && node.aspectLocked === true;
}

/**
 * Sets the width and/or height of each unlocked node among `ids`. A node
 * keeps its (local) top-left corner where it is, rotated or not. An image
 * with its aspect lock on derives the other side from its current
 * proportions; giving both sides then follows the width.
 */
export function setNodesSize(state, ids, { w = null, h = null } = {}) {
  const width = w == null ? null : cleanSize(w);
  const height = h == null ? null : cleanSize(h);
  if (width == null && height == null) return state;
  const targets = new Set(sizeTargets(state, ids).map((n) => n.id));
  let changed = false;
  const nodes = state.nodes.map((n) => {
    if (!targets.has(n.id)) return n;
    let nw = width ?? n.w;
    let nh = height ?? n.h;
    if (keepsAspect(n) && n.w > 0 && n.h > 0) {
      if (width != null) nh = Math.max(MIN_NODE_SIZE, Math.round((width * n.h) / n.w));
      else nw = Math.max(MIN_NODE_SIZE, Math.round((height * n.w) / n.h));
    }
    if (nw === n.w && nh === n.h) return n;
    changed = true;
    return resizeAnchored(n, nw, nh, 0, 0);
  });
  return changed ? { ...state, nodes } : state;
}

/** Turns the aspect lock of each unlocked image among `ids` on or off. */
export function setImagesAspectLocked(state, ids, locked) {
  const targets = new Set(sizeTargets(state, ids).filter((n) => n.type === "image").map((n) => n.id));
  let changed = false;
  const nodes = state.nodes.map((n) => {
    if (!targets.has(n.id) || (n.aspectLocked === true) === locked) return n;
    changed = true;
    return { ...n, aspectLocked: locked };
  });
  return changed ? { ...state, nodes } : state;
}

/** The resize cursor for a handle whose upright direction is `baseDeg` (n = 0, ne = 45, ...) on a node turned `rotation`. */
export function rotatedResizeCursor(baseDeg, rotation) {
  const CURSORS = ["ns-resize", "nesw-resize", "ew-resize", "nwse-resize"];
  const step = Math.round((((baseDeg + rotation) % 180) + 180) / 45) % 4;
  return CURSORS[step];
}

/** How far above its box (world px) the rotation handle reaches; see RotateHandle. */
export const ROTATE_HANDLE_REACH = 30;
