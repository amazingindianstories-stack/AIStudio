/**
 * Keyboard navigation over the board graph (never the DOM, so it reaches
 * objects that viewport culling has not mounted).
 *
 * The board reads like a page: Tab walks the objects at one level (the top
 * of the board, or the inside of one frame) row by row, left to right. A
 * group is one stop at its level. Enter goes into the selected frame or
 * group, Escape comes back out to it, and Cmd/Ctrl + arrows jump to the
 * nearest object in that direction anywhere on the board.
 */

const center = (n) => ({ x: n.x + n.w / 2, y: n.y + n.h / 2 });

/** Ids of `nodes` in reading order: rows top to bottom, each row left to right. */
export function readingOrder(nodes) {
  const sorted = [...nodes].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const node of sorted) {
    const row = rows[rows.length - 1];
    // A node starts a new row once its top passes the middle of the row's first object.
    if (row && node.y < row.top + row.height / 2) row.items.push(node);
    else rows.push({ top: node.y, height: Math.max(node.h, 1), items: [node] });
  }
  return rows.flatMap((row) => row.items.sort((a, b) => a.x - b.x || a.y - b.y)).map((n) => n.id);
}

/** The frame a node sits in, or null at the top level. */
function containerOf(nodesById, node) {
  return node?.parentId && nodesById.get(node.parentId) ? node.parentId : null;
}

/**
 * Tab stops at one level: every node directly in `container` (a frame id, or
 * null for the top level), a group standing as one stop of all its members.
 */
export function navigationStops(present, container) {
  const nodesById = new Map(present.nodes.map((n) => [n.id, n]));
  const level = present.nodes.filter((n) => containerOf(nodesById, n) === container);
  const groups = new Map();
  const stops = [];
  for (const node of level) {
    if (!node.groupId) {
      stops.push({ id: node.id, ids: [node.id], x: node.x, y: node.y, w: node.w, h: node.h });
      continue;
    }
    let group = groups.get(node.groupId);
    if (!group) {
      group = { id: node.id, ids: [], x: Infinity, y: Infinity, x1: -Infinity, y1: -Infinity };
      groups.set(node.groupId, group);
      stops.push(group);
    }
    group.ids.push(node.id);
    group.x = Math.min(group.x, node.x);
    group.y = Math.min(group.y, node.y);
    group.x1 = Math.max(group.x1, node.x + node.w);
    group.y1 = Math.max(group.y1, node.y + node.h);
  }
  for (const group of groups.values()) {
    group.w = group.x1 - group.x;
    group.h = group.y1 - group.y;
  }
  const byId = new Map(stops.map((stop) => [stop.id, stop]));
  return readingOrder(stops).map((id) => byId.get(id));
}

/** The level the current selection is browsing: the frame of its first node, or the top level. */
function currentLevel(present, selection) {
  const nodesById = new Map(present.nodes.map((n) => [n.id, n]));
  const first = nodesById.get(selection[0]);
  return first ? containerOf(nodesById, first) : null;
}

function stopIndex(stops, selection) {
  const selected = new Set(selection);
  return stops.findIndex((stop) => stop.ids.some((id) => selected.has(id)));
}

/**
 * The selection after Tab (`step` 1) or Shift+Tab (-1). Inside a frame it
 * wraps at the ends; at the top level it stops, returning null past the last
 * or before the first stop so focus can leave the board. Null on an empty level.
 */
export function stepStop(present, selection, step) {
  const level = currentLevel(present, selection);
  const stops = navigationStops(present, level);
  if (!stops.length) return null;
  const index = stopIndex(stops, selection);
  if (index < 0) return stops[step > 0 ? 0 : stops.length - 1].ids;
  const next = index + step;
  if (level === null && (next < 0 || next >= stops.length)) return null;
  return stops[(next + stops.length) % stops.length].ids;
}

/** The first or last stop at the selection's level (Home / End). */
export function edgeStop(present, selection, which) {
  const stops = navigationStops(present, currentLevel(present, selection));
  if (!stops.length) return null;
  return (which === "last" ? stops[stops.length - 1] : stops[0]).ids;
}

/** Enter: into the selected frame (its first child) or group (its first member alone). */
export function enterContainer(present, selection) {
  if (!selection.length) return null;
  const nodesById = new Map(present.nodes.map((n) => [n.id, n]));
  const first = nodesById.get(selection[0]);
  if (!first) return null;
  const selected = new Set(selection);
  if (first.groupId && present.nodes.filter((n) => n.groupId === first.groupId).every((n) => selected.has(n.id)) && selection.length > 1) {
    const members = present.nodes.filter((n) => n.groupId === first.groupId);
    return [readingOrder(members)[0]];
  }
  if (selection.length === 1 && first.type === "frame") {
    const stops = navigationStops(present, first.id);
    return stops.length ? stops[0].ids : null;
  }
  return null;
}

/** Escape inside a group selects the whole group; inside a frame, the frame. Null at the top. */
export function leaveContainer(present, selection) {
  if (!selection.length) return null;
  const nodesById = new Map(present.nodes.map((n) => [n.id, n]));
  const first = nodesById.get(selection[0]);
  if (!first) return null;
  if (first.groupId && selection.length === 1) {
    const members = present.nodes.filter((n) => n.groupId === first.groupId).map((n) => n.id);
    if (members.length > 1) return members;
  }
  const container = containerOf(nodesById, first);
  return container ? [container] : null;
}

const DIRECTIONS = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
};

/**
 * The nearest object from the selection in `direction` ("left", "right", "up",
 * "down"), anywhere on the board: it must lie ahead within 60 degrees of the
 * direction, and straight-ahead objects beat closer ones off to the side.
 */
export function spatialNeighbor(present, selection, direction) {
  const dir = DIRECTIONS[direction];
  if (!dir) return null;
  const selected = new Set(selection);
  const from = present.nodes.filter((n) => selected.has(n.id));
  if (!from.length) return null;
  const origin = from.reduce((acc, n) => {
    const c = center(n);
    return { x: acc.x + c.x / from.length, y: acc.y + c.y / from.length };
  }, { x: 0, y: 0 });
  let best = null;
  let bestScore = Infinity;
  for (const node of present.nodes) {
    if (selected.has(node.id)) continue;
    const c = center(node);
    const ahead = (c.x - origin.x) * dir.x + (c.y - origin.y) * dir.y;
    const side = Math.abs((c.x - origin.x) * dir.y + (c.y - origin.y) * dir.x);
    if (ahead <= 0.5 || side > ahead * Math.tan(Math.PI / 3)) continue;
    const score = ahead + side * 2;
    if (score < bestScore) {
      bestScore = score;
      best = node.id;
    }
  }
  return best;
}
