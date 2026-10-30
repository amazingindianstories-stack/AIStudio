/**
 * Locked objects (Miro's lock and protected lock). A locked object can still
 * be selected, copied and unlocked, but not moved, resized, rotated, edited or
 * deleted; objects on a locked layer behave the same. A protected lock names
 * who set it, and only that person can lift it: the server puts back any other
 * change to a protected object (backend/apps/canvas/locks.py), so the editor
 * checks the same rule up front instead of losing the edit after a save.
 *
 * Every rule here reads the board data, never the DOM, so it holds for
 * objects culled off-screen too.
 */

function layerLocked(state, layerId) {
  if (!layerId) return false;
  const layers = state?.settings?.layers;
  if (!layers) return false;
  for (const layer of layers) if (layer.id === layerId) return layer.locked === true;
  return false;
}

function nodeOf(state, nodeOrId) {
  if (nodeOrId && typeof nodeOrId === "object") return nodeOrId;
  return state?.nodes?.find((n) => n.id === nodeOrId) ?? null;
}

/** True when the node (or the node with this id) may not be changed: it is locked, or its layer is. */
export function isLocked(state, nodeOrId) {
  const node = nodeOf(state, nodeOrId);
  if (!node) return false;
  return node.locked === true || layerLocked(state, node.layerId);
}

/** A lock check over many ids at once: one pass over the layers, then a Set lookup per node. */
export function lockedIdSet(state) {
  const lockedLayers = new Set((state?.settings?.layers ?? []).filter((layer) => layer.locked).map((layer) => layer.id));
  const ids = new Set();
  for (const node of state?.nodes ?? []) {
    if (node.locked === true || (node.layerId && lockedLayers.has(node.layerId))) ids.add(node.id);
  }
  return ids;
}

/** `ids` without the locked nodes, in the same order. */
export function unlockedIds(state, ids) {
  if (!ids.length) return ids;
  const locked = lockedIdSet(state);
  if (!locked.size) return ids;
  return ids.filter((id) => !locked.has(id));
}

/** Whether `actorId` may lift this node's own lock (a layer lock is lifted on the layer). */
export function canUnlock(node, actorId) {
  if (!node?.locked) return false;
  return node.lockProtected !== true || (actorId != null && node.lockedBy === String(actorId));
}

/**
 * The node locked by `actorId`, protected when asked for (the caller checks
 * the person is a co-owner or owner, as the server does).
 */
export function lockNode(node, actorId, isProtected = false) {
  const next = { ...node, locked: true };
  delete next.lockProtected;
  delete next.lockedBy;
  if (actorId != null) {
    next.lockedBy = String(actorId);
    if (isProtected) next.lockProtected = true;
  }
  return next;
}

export function unlockNode(node) {
  const next = { ...node };
  delete next.locked;
  delete next.lockedBy;
  delete next.lockProtected;
  return next;
}

/** A copy carries no lock: a pasted or duplicated object is the copier's to change. */
export function withoutLock(node) {
  return node.locked || node.lockedBy || node.lockProtected ? unlockNode(node) : node;
}
