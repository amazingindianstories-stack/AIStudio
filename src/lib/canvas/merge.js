/**
 * Three-way merge of board graphs, so several people can edit one board
 * without overwriting each other (conflict-safe autosave).
 *
 * `base` is the graph this tab last synced with the server, `local` is the
 * tab's working graph and `remote` is the server's newer graph. Nodes and
 * connectors merge per id:
 * - changed (added, edited or deleted) on one side only: that side wins;
 * - changed on both sides: local wins, because it is this person's unsaved work
 *   (so a local delete beats a remote edit, and a local edit survives a remote
 *   delete);
 * - ids in `keepLocal` (the text being typed, the image being cropped) are not
 *   removed under the person working on them when someone else deletes them.
 * The array order is the z-order: it follows remote unless only this tab
 * reordered, and items missing from that order are placed below the item
 * that was above them on the other side. The viewport is each person's own and always
 * stays local. Unchanged items keep their object identity so React only
 * re-renders what another person changed.
 */

export function sameValue(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!sameValue(a[i], b[i])) return false;
    return true;
  }
  const keysA = Object.keys(a).filter((key) => a[key] !== undefined);
  const keysB = Object.keys(b).filter((key) => b[key] !== undefined);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) if (!sameValue(a[key], b[key])) return false;
  return true;
}

function byId(items) {
  const map = new Map();
  for (const item of items) map.set(item.id, item);
  return map;
}

function relativeOrder(ids, members) {
  return ids.filter((id) => members.has(id));
}

function sameSequence(a, b) {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function mergeOrder(baseIds, localIds, remoteIds, keep) {
  const inBase = new Set(baseIds);
  const inLocal = new Set(localIds);
  const localReordered = !sameSequence(relativeOrder(localIds, inBase), relativeOrder(baseIds, inLocal));
  const [primary, secondary] = localReordered ? [localIds, remoteIds] : [remoteIds, localIds];
  const order = primary.filter((id) => keep.has(id));
  const placed = new Set(order);
  // Walk from the top so an item added on top of the other side stays on top.
  let above = null;
  for (let index = secondary.length - 1; index >= 0; index -= 1) {
    const id = secondary[index];
    if (keep.has(id) && !placed.has(id)) {
      order.splice(above === null ? order.length : order.indexOf(above), 0, id);
      placed.add(id);
    }
    if (placed.has(id)) above = id;
  }
  return order;
}

function mergeItems(baseItems, localItems, remoteItems, keepLocal) {
  const base = byId(baseItems);
  const local = byId(localItems);
  const remote = byId(remoteItems);
  const chosen = new Map();
  for (const id of new Set([...base.keys(), ...local.keys(), ...remote.keys()])) {
    const l = local.get(id);
    const r = remote.get(id);
    const held = keepLocal.has(id) && l !== undefined && r === undefined;
    const b = base.get(id);
    const localChanged = held || !sameValue(b, l);
    // Neither side changed it: keep the local object so nothing re-renders.
    const item = localChanged || sameValue(b, r) ? l : r;
    if (item !== undefined) chosen.set(id, item);
  }
  const ids = (items) => items.map((item) => item.id);
  return mergeOrder(ids(baseItems), ids(localItems), ids(remoteItems), chosen).map((id) => chosen.get(id));
}

function attachedTo(endpoint, nodeIds) {
  return !("nodeId" in endpoint) || nodeIds.has(endpoint.nodeId);
}

/** Merges `remote` into `local` relative to `base`; see the module comment for the rules. */
export function mergeCanvasStates(base, local, remote, { keepLocal = new Set() } = {}) {
  const merged = mergeItems(base.nodes, local.nodes, remote.nodes, keepLocal);
  const nodeIds = new Set(merged.map((node) => node.id));
  // A frame deleted on one side releases children kept from the other, as validation does on load.
  const nodes = merged.map((node) => (node.parentId && !nodeIds.has(node.parentId) ? { ...node, parentId: null } : node));
  // A node deleted on one side drops connectors attached to it on the other.
  const connectors = mergeItems(base.connectors, local.connectors, remote.connectors, keepLocal)
    .filter((connector) => attachedTo(connector.from, nodeIds) && attachedTo(connector.to, nodeIds));
  const unchanged = (next, prev) => next.length === prev.length && next.every((item, index) => item === prev[index]);
  if (unchanged(nodes, local.nodes) && unchanged(connectors, local.connectors)) return local;
  return { ...local, nodes, connectors };
}

/**
 * Applies the same remote change to every undo/redo snapshot, so undo only
 * reverts this person's own steps: an item someone else changed shows their
 * latest version in every snapshot this person never touched it in.
 * `presentBase`, when given, is the base for the working graph instead of `base`.
 */
export function rebaseHistory(history, base, remote, { keepLocal, presentBase = base } = {}) {
  const rebase = (snapshot) => mergeCanvasStates(base, snapshot, remote);
  return {
    past: history.past.map(rebase),
    present: mergeCanvasStates(presentBase, history.present, remote, { keepLocal }),
    future: history.future.map(rebase),
  };
}
