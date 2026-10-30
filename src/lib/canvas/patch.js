/**
 * Per-object board saves and reads, mirrored by backend/apps/canvas/patch.py.
 *
 * A patch is a save sent as the difference from the version it starts from:
 * for nodes and for connectors the items added or changed (`upsert`, whole
 * items), the ids of the upserted items that are new (`add`, which the server
 * checks against its graph) and the ids deleted (`delete`), plus the full id order only when the
 * order is not "the kept items in their old order, then the added ones in
 * patch order". The server rebuilds the whole graph from the stored one and
 * saves it exactly as a full save, so an edit on a board of thousands of
 * objects sends only the objects it touched.
 *
 * Open boards read the other direction the same way: the objects changed since
 * the version they hold, rebuilt over that version and checked against a hash
 * of the server's order before they are merged.
 */
import { sameValue } from "./merge";

const KINDS = ["nodes", "connectors"];
const ORDER_KEYS = { nodes: "nodeOrder", connectors: "connectorOrder" };

function sameOrder(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The patch that turns `base` (the graph of the version the save starts from)
 * into `next`. The viewport is always sent: it is each person's own and tiny.
 */
export function buildBoardPatch(base, next) {
  const patch = { viewport: next.viewport };
  for (const kind of KINDS) {
    const before = new Map();
    for (const item of base[kind]) before.set(item.id, item);
    const upsert = [];
    const added = [];
    const present = new Set();
    for (const item of next[kind]) {
      present.add(item.id);
      const old = before.get(item.id);
      if (old === undefined) added.push(item.id);
      if (old === undefined || (old !== item && !sameValue(old, item))) upsert.push(item);
    }
    const deleted = [];
    const kept = [];
    for (const item of base[kind]) {
      if (present.has(item.id)) kept.push(item.id);
      else deleted.push(item.id);
    }
    patch[kind] = { upsert, add: added, delete: deleted };
    const order = next[kind].map((item) => item.id);
    if (!sameOrder(order, kept.concat(added))) patch[ORDER_KEYS[kind]] = order;
  }
  return patch;
}

/**
 * The graph `patch` makes of `base`, as the server builds it. Throws when an
 * explicit order does not name every item exactly once, or when a patch's
 * `add` does not name exactly the upserted items `base` lacks (a `/changes`
 * reply has no `add`).
 */
export function applyBoardPatch(base, patch) {
  const graph = { ...base };
  for (const kind of KINDS) {
    const items = new Map();
    for (const item of patch[kind]?.upsert ?? []) items.set(item.id, item);
    const deleted = new Set(patch[kind]?.delete ?? []);
    const result = [];
    for (const item of base[kind]) {
      if (deleted.has(item.id)) continue;
      const updated = items.get(item.id);
      items.delete(item.id);
      result.push(updated ?? item);
    }
    const added = patch[kind]?.add && new Set(patch[kind].add);
    if (added && (added.size !== items.size || [...added].some((id) => !items.has(id)))) {
      throw new Error("patch add does not match the items it adds");
    }
    result.push(...items.values());
    const order = patch[ORDER_KEYS[kind]];
    if (order) {
      const byId = new Map(result.map((item) => [item.id, item]));
      if (order.length !== result.length || byId.size !== result.length || new Set(order).size !== order.length || order.some((id) => !byId.has(id))) {
        throw new Error("patch order does not match its items");
      }
      graph[kind] = order.map((id) => byId.get(id));
    } else {
      graph[kind] = result;
    }
  }
  if (patch.viewport) graph.viewport = patch.viewport;
  return graph;
}

/**
 * FNV-1a (32 bit) over the ids' UTF-16 code units, each id followed by a
 * newline; matches order_hash in backend/apps/canvas/patch.py.
 */
export function orderHash(ids) {
  let value = 0x811c9dc5;
  for (const id of ids) {
    const text = `${id}\n`;
    for (let i = 0; i < text.length; i += 1) value = Math.imul(value ^ text.charCodeAt(i), 0x01000193) >>> 0;
  }
  return value;
}

/**
 * The graph a `/changes` reply makes of `base`, the graph of the version it
 * was asked from, or null when the rebuilt order differs from the server's
 * (a reorder, which records no object) and the whole board must be fetched.
 */
export function boardFromChanges(base, changes) {
  let graph;
  try {
    graph = applyBoardPatch(base, changes);
  } catch {
    return null;
  }
  const nodes = orderHash(graph.nodes.map((item) => item.id));
  const connectors = orderHash(graph.connectors.map((item) => item.id));
  return nodes === changes.nodeOrderHash && connectors === changes.connectorOrderHash ? graph : null;
}
