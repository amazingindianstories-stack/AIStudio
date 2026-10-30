/**
 * Arranging several objects at once: align, distribute, auto layout (the
 * spacing handle on a multi-selection), smart duplicate, filter by type and
 * clear content. Pure functions over the board data; the store slice in
 * arrange-actions.js applies them as single undo steps.
 *
 * Rules shared by every arrange command:
 * - Locked objects are skipped entirely: they neither move nor count towards
 *   the target edge or the spacing, as if they were not selected.
 * - A group moves as one unit: its members keep their relative positions and
 *   the group's combined box is what gets aligned or spaced.
 * - Moving a frame carries its unselected children along, and a moved object
 *   joins whichever frame its center lands in, as with a drag.
 */
import { computeFrameMembership, nodeBounds } from "./geometry";
import { lockedIdSet } from "./locks";
import { isShapeNode } from "./shapes";

export const ALIGN_MODES = ["left", "hcenter", "right", "top", "vcenter", "bottom"];

/** Miro's gap between an object and its smart duplicate, in world units. */
export const DUPLICATE_GAP = 20;

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

/**
 * The selected objects that may move, gathered into units: one per group
 * (all its selected members) and one per ungrouped object. Each unit has
 * `ids` and the union `box` of its members, in board order.
 */
export function arrangeUnits(state, ids) {
  const locked = lockedIdSet(state);
  const wanted = new Set(ids);
  const units = [];
  const byGroup = new Map();
  for (const node of state.nodes) {
    if (!wanted.has(node.id) || locked.has(node.id)) continue;
    if (node.groupId) {
      const unit = byGroup.get(node.groupId);
      if (unit) {
        unit.nodes.push(node);
        continue;
      }
      const created = { nodes: [node] };
      byGroup.set(node.groupId, created);
      units.push(created);
    } else {
      units.push({ nodes: [node] });
    }
  }
  return units.map((u) => ({ ids: u.nodes.map((n) => n.id), box: unionBounds(u.nodes.map(nodeBounds)) }));
}

function deltasOf(units, shift) {
  const deltas = new Map();
  for (const unit of units) {
    const { dx, dy } = shift(unit);
    if (!dx && !dy) continue;
    for (const id of unit.ids) deltas.set(id, { dx, dy });
  }
  return deltas;
}

/** Per-node moves that align the units' boxes on one edge or center line. */
export function alignDeltas(state, ids, mode) {
  const units = arrangeUnits(state, ids);
  if (units.length < 2 || !ALIGN_MODES.includes(mode)) return new Map();
  const all = unionBounds(units.map((u) => u.box));
  return deltasOf(units, ({ box }) => {
    switch (mode) {
      case "left":
        return { dx: all.x - box.x, dy: 0 };
      case "right":
        return { dx: all.x + all.w - (box.x + box.w), dy: 0 };
      case "hcenter":
        return { dx: all.x + all.w / 2 - (box.x + box.w / 2), dy: 0 };
      case "top":
        return { dx: 0, dy: all.y - box.y };
      case "bottom":
        return { dx: 0, dy: all.y + all.h - (box.y + box.h) };
      default:
        return { dx: 0, dy: all.y + all.h / 2 - (box.y + box.h / 2) };
    }
  });
}

const AXIS = {
  x: { pos: "x", size: "w" },
  y: { pos: "y", size: "h" },
};

function sortedAlong(units, axis) {
  const { pos, size } = AXIS[axis];
  return [...units].sort((a, b) => a.box[pos] + a.box[size] / 2 - (b.box[pos] + b.box[size] / 2) || a.box[pos] - b.box[pos]);
}

/**
 * Per-node moves that space 3+ units evenly along `axis` ("x": horizontally,
 * "y": vertically): the first and last stay put, the rest are placed so every
 * gap between neighbours is equal.
 */
export function distributeDeltas(state, ids, axis) {
  const units = sortedAlong(arrangeUnits(state, ids), axis);
  if (units.length < 3) return new Map();
  const { pos, size } = AXIS[axis];
  const start = Math.min(...units.map((u) => u.box[pos]));
  const end = Math.max(...units.map((u) => u.box[pos] + u.box[size]));
  const total = units.reduce((sum, u) => sum + u.box[size], 0);
  const gap = (end - start - total) / (units.length - 1);
  let cursor = start;
  const targets = new Map();
  for (const unit of units) {
    targets.set(unit, cursor);
    cursor += unit.box[size] + gap;
  }
  return deltasOf(units, (unit) => {
    const d = targets.get(unit) - unit.box[pos];
    return axis === "x" ? { dx: d, dy: 0 } : { dx: 0, dy: d };
  });
}

/** The axis the units already run along: the one their centers spread over more. */
export function dominantAxis(state, ids) {
  const units = arrangeUnits(state, ids);
  if (units.length < 2) return "x";
  const cx = units.map((u) => u.box.x + u.box.w / 2);
  const cy = units.map((u) => u.box.y + u.box.h / 2);
  return Math.max(...cx) - Math.min(...cx) >= Math.max(...cy) - Math.min(...cy) ? "x" : "y";
}

/**
 * The gap that lays the units out in a line along `axis` exactly as long as
 * their current extent (never negative), so the spacing handle starts from
 * the arrangement on screen.
 */
export function autoLayoutBaseGap(state, ids, axis) {
  const units = arrangeUnits(state, ids);
  if (units.length < 2) return 0;
  const { pos, size } = AXIS[axis];
  const start = Math.min(...units.map((u) => u.box[pos]));
  const end = Math.max(...units.map((u) => u.box[pos] + u.box[size]));
  const total = units.reduce((sum, u) => sum + u.box[size], 0);
  return Math.max(0, (end - start - total) / (units.length - 1));
}

/**
 * Per-node moves that lay 2+ units out in one row (`axis` "x") or column
 * ("y") with `gap` world units between neighbours, in their current order
 * along that axis, starting at the selection's left (top) edge and lined up
 * on its top (left) edge.
 */
export function autoLayoutDeltas(state, ids, axis, gap) {
  const units = sortedAlong(arrangeUnits(state, ids), axis);
  if (units.length < 2) return new Map();
  const all = unionBounds(units.map((u) => u.box));
  const spacing = Math.max(0, gap);
  let cursor = axis === "x" ? all.x : all.y;
  const targets = new Map();
  for (const unit of units) {
    targets.set(unit, cursor);
    cursor += (axis === "x" ? unit.box.w : unit.box.h) + spacing;
  }
  return deltasOf(units, (unit) =>
    axis === "x"
      ? { dx: targets.get(unit) - unit.box.x, dy: all.y - unit.box.y }
      : { dx: all.x - unit.box.x, dy: targets.get(unit) - unit.box.y }
  );
}

/**
 * Applies per-node moves to the board: a moved frame's unselected, unlocked
 * children follow it, and every moved object other than a frame joins the
 * frame its center now sits in (or leaves one), as after a drag.
 */
export function applyDeltas(state, deltas) {
  if (!deltas.size) return state;
  const locked = lockedIdSet(state);
  const moves = new Map(deltas);
  for (const node of state.nodes) {
    if (!node.parentId || moves.has(node.id) || locked.has(node.id)) continue;
    const parentMove = deltas.get(node.parentId);
    if (parentMove) moves.set(node.id, parentMove);
  }
  let nodes = state.nodes.map((n) => {
    const move = moves.get(n.id);
    return move ? { ...n, x: n.x + move.dx, y: n.y + move.dy } : n;
  });
  const frames = nodes.filter((n) => n.type === "frame");
  nodes = nodes.map((n) => {
    if (n.type === "frame" || !deltas.has(n.id)) return n;
    const parentId = computeFrameMembership(n, frames);
    return parentId !== (n.parentId ?? null) ? { ...n, parentId } : n;
  });
  return { ...state, nodes };
}

// ---- smart duplicate ----

const DIRECTIONS = {
  left: [-1, 0],
  right: [1, 0],
  up: [0, -1],
  down: [0, 1],
};

/** Where a copy of `bounds` lands beside it in `direction`, `gap` beyond its edge. */
export function duplicateOffset(bounds, direction, gap = DUPLICATE_GAP) {
  const [sx, sy] = DIRECTIONS[direction] ?? [0, 0];
  return { dx: sx * (bounds.w + gap), dy: sy * (bounds.h + gap) };
}

// ---- filter by type ----

const KINDS = [
  { kind: "sticky", label: "Sticky notes" },
  { kind: "shape", label: "Shapes" },
  { kind: "text", label: "Text" },
  { kind: "image", label: "Images" },
  { kind: "frame", label: "Frames" },
];

/** The filter category a node belongs to (every shape type is "shape"). */
export function kindOf(node) {
  return isShapeNode(node) ? "shape" : node.type;
}

/** Each object type in the selection with its count, in a fixed order. */
export function selectionKinds(state, selection) {
  const wanted = new Set(selection);
  const counts = new Map();
  for (const node of state.nodes) {
    if (!wanted.has(node.id)) continue;
    const kind = kindOf(node);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const known = KINDS.filter((k) => counts.has(k.kind)).map((k) => ({ ...k, count: counts.get(k.kind) }));
  const other = [...counts.keys()].filter((kind) => !KINDS.some((k) => k.kind === kind));
  return [...known, ...other.map((kind) => ({ kind, label: kind, count: counts.get(kind) }))];
}

/** The selected ids of one kind, in selection order. */
export function idsOfKind(state, selection, kind) {
  const kinds = new Map(state.nodes.map((n) => [n.id, kindOf(n)]));
  return selection.filter((id) => kinds.get(id) === kind);
}

// ---- clear content ----

/** Objects whose text Clear content empties: sticky notes, text boxes and shapes. */
export function holdsText(node) {
  return node.type === "sticky" || node.type === "text" || isShapeNode(node);
}

/** The node with its text and formatting removed and its style kept (the same node when already empty). */
export function clearedNode(node) {
  if (!holdsText(node) || (!node.text && !node.marks)) return node;
  const next = { ...node, text: "" };
  delete next.marks;
  return next;
}
