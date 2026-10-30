/**
 * Board layers (Miro's Layers panel). `settings.layers` lists the layers above
 * the default one, bottom to top; a node names its layer in `layerId`, and a
 * node without one is on the default layer, which is always at the bottom,
 * always visible and cannot be locked, renamed or deleted. Layer order comes
 * before the node array order, so "bring to front" stays within a layer.
 * Locking a layer is board-wide (board data); hiding one is each person's own
 * view (see layer-visibility.js).
 */
import { MAX_LAYER_NAME, MAX_LAYERS } from "./serialization";

export const DEFAULT_LAYER_NAME = "Default layer";
export { MAX_LAYERS, MAX_LAYER_NAME };

export function layersOf(state) {
  return state?.settings?.layers ?? [];
}

function withLayers(state, layers) {
  const settings = { ...(state.settings ?? {}) };
  if (layers.length) settings.layers = layers;
  else delete settings.layers;
  const next = { ...state };
  if (Object.keys(settings).length) next.settings = settings;
  else delete next.settings;
  return next;
}

/** A name for a new layer that no other layer has: "Layer 2", "Layer 3", ... */
export function nextLayerName(state, base = "Layer") {
  const taken = new Set(layersOf(state).map((layer) => layer.name));
  for (let n = layersOf(state).length + 2; ; n += 1) {
    const name = `${base} ${n}`;
    if (!taken.has(name)) return name;
  }
}

/** Adds a layer on top. Returns the state unchanged at the layer limit. */
export function addLayer(state, id, name = nextLayerName(state)) {
  const layers = layersOf(state);
  if (layers.length >= MAX_LAYERS) return state;
  return withLayers(state, [...layers, { id, name: name.slice(0, MAX_LAYER_NAME) || "Layer" }]);
}

export function renameLayer(state, id, name) {
  const trimmed = name.trim().slice(0, MAX_LAYER_NAME);
  if (!trimmed) return state;
  return withLayers(state, layersOf(state).map((layer) => (layer.id === id ? { ...layer, name: trimmed } : layer)));
}

export function setLayerLocked(state, id, locked) {
  return withLayers(
    state,
    layersOf(state).map((layer) => {
      if (layer.id !== id) return layer;
      const next = { ...layer };
      if (locked) next.locked = true;
      else delete next.locked;
      return next;
    })
  );
}

/** Moves a layer to `index` in the bottom-to-top list of the layers above the default one. */
export function moveLayer(state, id, index) {
  const layers = layersOf(state);
  const from = layers.findIndex((layer) => layer.id === id);
  if (from < 0) return state;
  const to = Math.max(0, Math.min(layers.length - 1, index));
  if (to === from) return state;
  const next = layers.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return withLayers(state, next);
}

/** Removes a layer with everything on it, and the connectors attached to those objects. */
export function deleteLayer(state, id) {
  const layers = layersOf(state);
  if (!layers.some((layer) => layer.id === id)) return state;
  const removed = new Set(state.nodes.filter((n) => n.layerId === id).map((n) => n.id));
  const attached = (end) => "nodeId" in end && removed.has(end.nodeId);
  const next = withLayers(state, layers.filter((layer) => layer.id !== id));
  return {
    ...next,
    nodes: state.nodes
      .filter((n) => !removed.has(n.id))
      .map((n) => (n.parentId && removed.has(n.parentId) ? { ...n, parentId: null } : n)),
    connectors: state.connectors.filter((c) => !attached(c.from) && !attached(c.to)),
  };
}

/** Puts the nodes with `ids` on layer `layerId` (null for the default layer). */
export function assignLayer(state, ids, layerId) {
  const target = layerId && layersOf(state).some((layer) => layer.id === layerId) ? layerId : null;
  const set = new Set(ids);
  let changed = false;
  const nodes = state.nodes.map((n) => {
    if (!set.has(n.id) || (n.layerId ?? null) === target) return n;
    changed = true;
    const next = { ...n };
    if (target) next.layerId = target;
    else delete next.layerId;
    return next;
  });
  return changed ? { ...state, nodes } : state;
}

/**
 * Copies a layer and everything on it into a new layer just above it: new
 * ids for the copies, frame children kept in their copied frames, and the
 * connectors between copied objects copied too. `newId` makes ids.
 */
export function duplicateLayer(state, id, layerId, newId) {
  const layers = layersOf(state);
  const index = layers.findIndex((layer) => layer.id === id);
  if (index < 0 || layers.length >= MAX_LAYERS) return state;
  const source = layers[index];
  const copy = { id: layerId, name: `${source.name} copy`.slice(0, MAX_LAYER_NAME) };
  if (source.locked) copy.locked = true;
  const nextLayers = layers.slice();
  nextLayers.splice(index + 1, 0, copy);
  const idMap = new Map();
  for (const n of state.nodes) if (n.layerId === id) idMap.set(n.id, newId());
  const clones = [];
  for (const n of state.nodes) {
    if (!idMap.has(n.id)) continue;
    const clone = { ...n, id: idMap.get(n.id), layerId };
    for (const key of ["createdBy", "createdAt", "updatedBy", "updatedAt"]) delete clone[key];
    if (clone.parentId) clone.parentId = idMap.get(clone.parentId) ?? clone.parentId;
    if (clone.groupId) clone.groupId = `${clone.groupId}:${layerId}`;
    clones.push(clone);
  }
  const endOf = (end) => ("nodeId" in end ? { ...end, nodeId: idMap.get(end.nodeId) } : end);
  const connectorClones = state.connectors
    .filter((c) => "nodeId" in c.from && "nodeId" in c.to && idMap.has(c.from.nodeId) && idMap.has(c.to.nodeId))
    .map((c) => {
      const clone = { ...c, id: newId(), from: endOf(c.from), to: endOf(c.to) };
      for (const key of ["createdBy", "createdAt", "updatedBy", "updatedAt"]) delete clone[key];
      return clone;
    });
  const next = withLayers(state, nextLayers);
  return { ...next, nodes: [...state.nodes, ...clones], connectors: [...state.connectors, ...connectorClones] };
}

/**
 * The board as it is drawn and hit-tested: nodes ordered by layer (default
 * first, then each layer bottom to top, array order within a layer) and
 * without the layers this person hides, nor connectors attached to them.
 * Returns `state` itself when nothing changes, so memoized views stay put.
 */
export function layeredView(state, hiddenLayerIds) {
  const layers = layersOf(state);
  if (!layers.length) return state;
  const rank = new Map(layers.map((layer, index) => [layer.id, index + 1]));
  const hidden = hiddenLayerIds?.length ? new Set(hiddenLayerIds.filter((id) => rank.has(id))) : null;
  const rankOf = (n) => (n.layerId ? (rank.get(n.layerId) ?? 0) : 0);
  let sorted = true;
  let previous = 0;
  for (const n of state.nodes) {
    const r = rankOf(n);
    if (r < previous) {
      sorted = false;
      break;
    }
    previous = r;
  }
  if (sorted && !hidden?.size) return state;
  let nodes = state.nodes;
  if (hidden?.size) nodes = nodes.filter((n) => !n.layerId || !hidden.has(n.layerId));
  if (!sorted) {
    nodes = nodes
      .map((n, index) => ({ n, index, r: rankOf(n) }))
      .sort((a, b) => a.r - b.r || a.index - b.index)
      .map((entry) => entry.n);
  }
  let connectors = state.connectors;
  if (hidden?.size) {
    const shown = new Set(nodes.map((n) => n.id));
    const visible = (end) => !("nodeId" in end) || shown.has(end.nodeId);
    connectors = connectors.filter((c) => visible(c.from) && visible(c.to));
  }
  return { ...state, nodes, connectors };
}

/** The ids of nodes on layers this person hides. */
export function hiddenNodeIds(state, hiddenLayerIds) {
  if (!hiddenLayerIds?.length) return new Set();
  const hidden = new Set(hiddenLayerIds);
  return new Set(state.nodes.filter((n) => n.layerId && hidden.has(n.layerId)).map((n) => n.id));
}
