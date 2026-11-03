// What a Sidekick's answer does to the board: its "actions" (add, update, delete, connect; see
// backend/apps/agents/sidekick.py) become one pure graph edit, so the panel applies a whole answer as a single
// undo step. Locked objects are never changed and ids the board does not hold are ignored.
import { colorPatch, inFreeSpace, stickyFill, stickyInk } from "./ai-formats.js";
import { isLocked } from "./locks.js";

export const MAX_ACTIONS = 40;
const DEFAULT_SIZE = { sticky: [200, 200], text: [240, 40], rect: [200, 120], ellipse: [160, 160], diamond: [180, 180], frame: [480, 320] };
const COLUMN_GAP = 24;

function newId() {
  return crypto.randomUUID();
}

function dims(action) {
  const [w, h] = DEFAULT_SIZE[action.type] ?? DEFAULT_SIZE.sticky;
  return [action.w > 0 ? action.w : w, action.h > 0 ? action.h : h];
}

/** One new object for an "add" action, placed at the action's own x and y or at the origin until the caller lays it out. */
export function nodeFor(action, now) {
  const [w, h] = dims(action);
  const base = { id: newId(), type: action.type, x: Number.isFinite(action.x) ? action.x : 0, y: Number.isFinite(action.y) ? action.y : 0, w, h, parentId: null, groupId: null, aiCreated: true, aiEditedAt: now };
  const text = action.text ?? "";
  switch (action.type) {
    case "text":
      return { ...base, text, fontSize: 18, align: "left", color: "#e8e6df" };
    case "rect":
    case "ellipse":
    case "diamond": {
      const fill = action.color || action.fill ? stickyFill(action) : "#ffffff";
      return { ...base, fill, color: stickyInk(fill), stroke: "#000000", strokeWidth: 1, ...(action.type === "rect" ? { cornerRadius: 0 } : {}), ...(text ? { text } : {}) };
    }
    case "frame":
      return { ...base, name: text || "Frame", fill: "transparent", stroke: "#000000" };
    default:
      return { ...base, type: "sticky", text, fill: stickyFill(action), fontSize: 16, color: stickyInk(stickyFill(action)), opacity: 1 };
  }
}

/** Unpositioned new nodes in a row centred on `center`, wrapping after six. */
function layOut(nodes, center) {
  const per = 6;
  const rows = [];
  for (let i = 0; i < nodes.length; i += per) rows.push(nodes.slice(i, i + per));
  const rowH = Math.max(...nodes.map((n) => n.h)) + COLUMN_GAP;
  const top = center.y - ((rows.length * rowH) - COLUMN_GAP) / 2;
  return rows.flatMap((row, r) => {
    const width = row.reduce((sum, n) => sum + n.w, 0) + (row.length - 1) * COLUMN_GAP;
    let x = center.x - width / 2;
    return row.map((n) => {
      const placed = { ...n, x, y: top + r * rowH };
      x += n.w + COLUMN_GAP;
      return placed;
    });
  });
}

/**
 * `present` with `actions` applied. `center` is where unpositioned objects go (the viewport centre). Returns
 * `{ next, added, changed, deleted, connected, skipped }`; `next === present` when nothing could be applied.
 */
export function applyActions(present, actions, { center = { x: 0, y: 0 }, now = Date.now() } = {}) {
  const list = (Array.isArray(actions) ? actions : []).slice(0, MAX_ACTIONS);
  let nodes = present.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const refs = new Map();
  const added = [];
  const unplaced = [];
  const removed = new Set();
  const connectors = [];
  let changed = 0;
  let skipped = 0;
  const editable = (id) => byId.has(id) && !removed.has(id) && !isLocked(present, byId.get(id));
  const resolve = (name) => refs.get(name) ?? (byId.has(name) && !removed.has(name) ? name : null);

  for (const action of list) {
    if (action.op === "add") {
      const node = nodeFor(action, now);
      added.push(node);
      if (!Number.isFinite(action.x) || !Number.isFinite(action.y)) unplaced.push(node.id);
      if (action.ref) refs.set(action.ref, node.id);
    } else if (action.op === "update") {
      if (!editable(action.id)) {
        skipped += 1;
        continue;
      }
      const node = byId.get(action.id);
      const patch = {};
      if (typeof action.text === "string") patch[node.type === "frame" ? "name" : "text"] = action.text;
      Object.assign(patch, colorPatch(node, action));
      for (const key of ["x", "y", "w", "h"]) if (Number.isFinite(action[key])) patch[key] = action[key];
      const next = { ...node, ...patch, aiEditedAt: now };
      if ("text" in patch) delete next.marks;
      byId.set(node.id, next);
      changed += 1;
    } else if (action.op === "delete") {
      if (!editable(action.id)) {
        skipped += 1;
        continue;
      }
      removed.add(action.id);
    } else if (action.op === "connect") {
      connectors.push(action);
    }
  }

  const unplacedSet = new Set(unplaced);
  const loose = added.filter((n) => unplacedSet.has(n.id));
  const survivors = nodes.filter((n) => !removed.has(n.id)).map((n) => byId.get(n.id));
  const laid = loose.length ? inFreeSpace(layOut(loose, center), survivors) : [];
  const laidById = new Map(laid.map((n) => [n.id, n]));
  const finalAdded = added.map((n) => laidById.get(n.id) ?? n);

  const alive = new Set([...survivors.map((n) => n.id), ...finalAdded.map((n) => n.id)]);
  const newConnectors = [];
  for (const c of connectors) {
    const from = resolve(c.from);
    const to = resolve(c.to);
    if (!from || !to || from === to || !alive.has(from) || !alive.has(to)) {
      skipped += 1;
      continue;
    }
    newConnectors.push({ id: newId(), from: { nodeId: from, anchor: "auto" }, to: { nodeId: to, anchor: "auto" }, kind: "arrow", stroke: "#000000", strokeWidth: 2 });
  }

  if (!finalAdded.length && !changed && !removed.size && !newConnectors.length) {
    return { next: present, added: [], changed: 0, deleted: 0, connected: 0, skipped };
  }
  const gone = removed;
  const kept = (present.connectors ?? []).filter((c) => !gone.has(c.from?.nodeId) && !gone.has(c.to?.nodeId));
  const next = { ...present, nodes: [...survivors, ...finalAdded], connectors: [...kept, ...newConnectors] };
  return { next, added: finalAdded.map((n) => n.id), changed, deleted: removed.size, connected: newConnectors.length, skipped };
}

/** A one-line account of what applying did, for the chat transcript. */
export function summarize(result) {
  const parts = [];
  if (result.added.length) parts.push(`added ${result.added.length}`);
  if (result.changed) parts.push(`changed ${result.changed}`);
  if (result.deleted) parts.push(`deleted ${result.deleted}`);
  if (result.connected) parts.push(`connected ${result.connected}`);
  if (result.skipped) parts.push(`skipped ${result.skipped}`);
  return parts.length ? parts.join(", ") : "nothing to change";
}
