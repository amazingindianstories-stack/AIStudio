/**
 * The Layers panel's rows: the top layer first and the default layer last,
 * as in Miro, each with how many objects it holds. Layer data lives in
 * layers.js; this only shapes it for the list.
 */
import { DEFAULT_LAYER_NAME, layersOf } from "./layers";

export function layerRows(state) {
  const layers = layersOf(state);
  const known = new Set(layers.map((layer) => layer.id));
  const counts = new Map();
  let onDefault = 0;
  for (const n of state?.nodes ?? []) {
    if (n.layerId && known.has(n.layerId)) counts.set(n.layerId, (counts.get(n.layerId) ?? 0) + 1);
    else onDefault += 1;
  }
  const rows = layers.map((layer, index) => ({
    id: layer.id,
    name: layer.name,
    locked: layer.locked === true,
    count: counts.get(layer.id) ?? 0,
    index,
    isDefault: false,
  }));
  rows.reverse();
  rows.push({ id: null, name: DEFAULT_LAYER_NAME, locked: false, count: onDefault, index: -1, isDefault: true });
  return rows;
}

/**
 * The bottom-to-top index a layer dropped on the row of `targetId` moves to,
 * in the list shown top first: above the target when dropped on its upper
 * half, below it otherwise. The default layer stays at the bottom.
 */
export function dropIndex(state, draggedId, targetId, above) {
  const layers = layersOf(state);
  const from = layers.findIndex((layer) => layer.id === draggedId);
  if (from < 0) return -1;
  if (targetId == null) return 0;
  const target = layers.findIndex((layer) => layer.id === targetId);
  if (target < 0) return -1;
  // In bottom-to-top terms "above" is the next index up.
  let to = above ? target + 1 : target;
  if (from < to) to -= 1;
  return Math.max(0, Math.min(layers.length - 1, to));
}

/** "3 objects", "1 object", "Empty". */
export function objectCountLabel(count) {
  if (!count) return "Empty";
  return `${count} object${count === 1 ? "" : "s"}`;
}
