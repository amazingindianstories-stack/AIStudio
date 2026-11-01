/**
 * The board's frames as an ordered list: the frames panel, presentation
 * slides and "Organize frames" all read this order.
 *
 * The order is board-wide and stored on each frame as `frameOrder`, so a
 * reorder saves through the per-object save path and merges with other
 * people's edits like any other change. Frames without a stored place (new
 * ones, or every frame before the first reorder) follow in reading order.
 */
import { nodeBounds } from "./geometry";
import { readingOrder } from "./keyboard-nav";
import { lockedIdSet } from "./locks";

export const FRAME_GAP = 80;

export function framesOf(present) {
  return present.nodes.filter((n) => n.type === "frame");
}

/** Frames in presentation order. */
export function orderedFrames(present) {
  const frames = framesOf(present);
  const placed = frames.filter((f) => Number.isFinite(f.frameOrder)).sort((a, b) => a.frameOrder - b.frameOrder);
  const placedIds = new Set(placed.map((f) => f.id));
  const rest = frames.filter((f) => !placedIds.has(f.id));
  const byId = new Map(rest.map((f) => [f.id, f]));
  return [...placed, ...readingOrder(rest).map((id) => byId.get(id))];
}

/**
 * Node edits (Map id to node) that store `ids` as the frame order. Every
 * frame gets its index so later frames keep their place; frames already at
 * their index are left untouched and send nothing.
 */
export function frameOrderEdits(present, ids) {
  const byId = new Map(framesOf(present).map((f) => [f.id, f]));
  const listed = ids.filter((id) => byId.has(id));
  const listedSet = new Set(listed);
  const order = [...listed, ...orderedFrames(present).map((f) => f.id).filter((id) => !listedSet.has(id))];
  const edits = new Map();
  order.forEach((id, index) => {
    const frame = byId.get(id);
    if (frame.frameOrder !== index) edits.set(id, { ...frame, frameOrder: index });
  });
  return edits;
}

/**
 * `moveInOrder` for a board with locked frames: locked frames never move and
 * keep their slot, and only the unlocked ones in `moving` are reordered
 * around them. `locked` is a Set of frame ids.
 */
export function moveInOrderLocked(ids, moving, beforeId, locked) {
  if (!locked?.size) return moveInOrder(ids, moving, beforeId);
  const free = ids.filter((id) => !locked.has(id));
  // A locked drop target stands for the next unlocked frame after it.
  let before = beforeId;
  if (before != null && locked.has(before)) {
    before = ids.slice(ids.indexOf(before)).find((id) => !locked.has(id)) ?? null;
  }
  const reordered = moveInOrder(free, moving.filter((id) => !locked.has(id)), before);
  let next = 0;
  return ids.map((id) => (locked.has(id) ? id : reordered[next++]));
}

/**
 * The node edits that move the frames in `moving` before `beforeId` (null:
 * to the end) in presentation order, locked frames keeping their slots.
 * Locked frames get no edit, as the lock forbids. Empty when the order stays
 * the same; null when the saved order would then differ from the requested
 * one (a locked frame would lose its slot).
 */
export function reorderFrameEdits(present, moving, beforeId) {
  const ids = orderedFrames(present).map((f) => f.id);
  const locked = lockedIdSet(present);
  const next = moveInOrderLocked(ids, moving, beforeId, locked);
  if (next.every((id, i) => id === ids[i])) return new Map();
  const edits = frameOrderEdits(present, next);
  for (const id of locked) edits.delete(id);
  const after = { ...present, nodes: present.nodes.map((n) => edits.get(n.id) ?? n) };
  return orderedFrames(after).every((f, i) => f.id === next[i]) ? edits : null;
}

/** `ids` with the frames in `moving` moved together to sit before `beforeId` (null: at the end). */
export function moveInOrder(ids, moving, beforeId) {
  const movingSet = new Set(moving);
  if (beforeId != null && movingSet.has(beforeId)) return ids;
  const kept = ids.filter((id) => !movingSet.has(id));
  const block = ids.filter((id) => movingSet.has(id));
  const at = beforeId == null ? -1 : kept.indexOf(beforeId);
  if (at < 0) return [...kept, ...block];
  return [...kept.slice(0, at), ...block, ...kept.slice(at)];
}

/**
 * "Organize frames": the node edits that lay the frames out in a grid in
 * their order, left to right then top to bottom, starting where the frames
 * now begin. Each frame's contents move with it. Locked frames, and
 * everything in them, stay where they are and take no place in the grid,
 * which steps past them so nothing lands within `gap` of one; a locked
 * object inside a moved frame stays put too, as when dragging.
 */
export function organizeFrameEdits(present, gap = FRAME_GAP) {
  const locked = lockedIdSet(present);
  const frames = orderedFrames(present).filter((f) => !locked.has(f.id));
  if (!frames.length) return new Map();
  const held = framesOf(present).filter((f) => locked.has(f.id)).map(nodeBounds);
  const blocker = (x, y, f) => held.find((b) => x < b.x + b.w + gap && b.x < x + f.w + gap && y < b.y + b.h + gap && b.y < y + f.h + gap);
  const columns = Math.ceil(Math.sqrt(frames.length));
  const originX = Math.min(...frames.map((f) => f.x));
  const originY = Math.min(...frames.map((f) => f.y));
  const moves = new Map();
  let y = originY;
  for (let row = 0; row * columns < frames.length; row += 1) {
    const cells = frames.slice(row * columns, (row + 1) * columns);
    let x = originX;
    for (const frame of cells) {
      for (let b = blocker(x, y, frame); b; b = blocker(x, y, frame)) x = b.x + b.w + gap;
      moves.set(frame.id, { dx: x - frame.x, dy: y - frame.y });
      x += frame.w + gap;
    }
    y += Math.max(...cells.map((f) => f.h)) + gap;
  }
  const edits = new Map();
  for (const node of present.nodes) {
    if (locked.has(node.id)) continue;
    const move = moves.get(node.type === "frame" ? node.id : node.parentId);
    if (move && (move.dx || move.dy)) edits.set(node.id, { ...node, x: node.x + move.dx, y: node.y + move.dy });
  }
  return edits;
}

/** The nodes inside `frame` (its children), for thumbnails and presenting. */
export function frameChildren(present, frame) {
  return present.nodes.filter((n) => n.parentId === frame.id);
}

/** A frame's display title: an empty title reads as "Untitled frame". */
export function frameTitle(frame) {
  return frame.name?.trim() ? frame.name : "Untitled frame";
}
