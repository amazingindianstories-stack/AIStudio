/**
 * Server stamps on board objects: who created and last changed each node and
 * connector, and when. The server writes them on every save and ignores what a
 * client sends (backend/apps/canvas/activity.py), so the client only carries
 * them, adopts the ones a save returns, and leaves them out of edit decisions.
 */
import { STAMP_KEYS } from "./serialization";

/** The item without its stamps: what a person actually edited. */
export function unstamped(item) {
  if (!item || !STAMP_KEYS.some((key) => key in item)) return item;
  const rest = { ...item };
  for (const key of STAMP_KEYS) delete rest[key];
  return rest;
}

function stampItems(items, stamps) {
  let changed = false;
  const next = items.map((item) => {
    const stamp = stamps[item.id];
    if (!stamp) return item;
    if (STAMP_KEYS.every((key) => item[key] === stamp[key])) return item;
    changed = true;
    return { ...unstamped(item), ...stamp };
  });
  return changed ? next : items;
}

/**
 * `state` with the stamps a save returned (`{id: {createdBy, ...}}`) on the
 * objects it names. Unnamed objects, and a state with nothing to change, keep
 * their identity.
 */
export function withServerStamps(state, stamps) {
  if (!state || !stamps || !Object.keys(stamps).length) return state;
  const nodes = stampItems(state.nodes, stamps);
  const connectors = stampItems(state.connectors, stamps);
  if (nodes === state.nodes && connectors === state.connectors) return state;
  return { ...state, nodes, connectors };
}
