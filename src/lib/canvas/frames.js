/**
 * The board's frames as an ordered list: the frames panel, presentation
 * slides and "Organize frames" all read this order.
 *
 * The order is board-wide and stored on each frame as `frameOrder`, so a
 * reorder saves through the per-object save path and merges with other
 * people's edits like any other change. Frames without a stored place (new
 * ones, or every frame before the first reorder) follow in reading order.
 */
import { readingOrder } from "./keyboard-nav";

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
 * now begin. Each frame's contents move with it.
 */
export function organizeFrameEdits(present, gap = FRAME_GAP) {
  const frames = orderedFrames(present);
  if (!frames.length) return new Map();
  const columns = Math.ceil(Math.sqrt(frames.length));
  const originX = Math.min(...frames.map((f) => f.x));
  const originY = Math.min(...frames.map((f) => f.y));
  const moves = new Map();
  let y = originY;
  for (let row = 0; row * columns < frames.length; row += 1) {
    const cells = frames.slice(row * columns, (row + 1) * columns);
    let x = originX;
    for (const frame of cells) {
      moves.set(frame.id, { dx: x - frame.x, dy: y - frame.y });
      x += frame.w + gap;
    }
    y += Math.max(...cells.map((f) => f.h)) + gap;
  }
  const edits = new Map();
  for (const node of present.nodes) {
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
