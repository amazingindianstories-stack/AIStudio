/**
 * Which asset the viewer shows next.
 *
 * The viewer is opened from a surface (the library grid, the chat thread, a
 * single inline card), and arrow keys must walk exactly the list that surface
 * shows, in the order it shows it - nothing from any other scope. This module
 * is the one definition of that rule, kept pure so it can be tested without a
 * store, a DOM or a network.
 *
 * Sources:
 *  - "feed":   the library grid. `items` is already the server-filtered,
 *              keyset-ordered slice for the open scope (folder, Unsorted,
 *              All assets, Favourites, search, kind filter).
 *  - "thread": the chat thread, which renders `threadItems` reversed
 *              (oldest at the top, newest at the bottom).
 *  - "single": one card with no list around it; arrows do nothing.
 */

export const VIEWER_SOURCES = ["feed", "thread", "single"];

/** Only finished rows with something to show have a viewer. */
export function isNavigable(item) {
  return Boolean(item) && item.status === "succeeded" && Boolean(item.url || item.poster);
}

/** The list a source displays, in display order, narrowed to viewable rows. */
export function viewerList(source, { items = [], threadItems = [] } = {}) {
  if (source === "thread") {
    const shown = [];
    for (let i = threadItems.length - 1; i >= 0; i -= 1) {
      if (isNavigable(threadItems[i])) shown.push(threadItems[i]);
    }
    return shown;
  }
  if (source === "feed") return items.filter(isNavigable);
  return [];
}

/** Arrow key -> direction. Left/Up go back, Right/Down go forward. */
export function keyDelta(key) {
  if (key === "ArrowLeft" || key === "ArrowUp") return -1;
  if (key === "ArrowRight" || key === "ArrowDown") return 1;
  return 0;
}

export function isVerticalKey(key) {
  return key === "ArrowUp" || key === "ArrowDown";
}

/**
 * Step along one ordered run of ids (the whole list, or one grid column).
 * Inside the run it is plain +/-1. Off the end:
 *  - going forward with more pages to fetch, ask for the next page;
 *  - once the whole scope is loaded, wrap round to the other end of the same
 *    run (the viewer has always wrapped, and the draft-finalization flow
 *    relies on it);
 *  - going back off the start while pages are still unloaded, stay put - the
 *    other end is not the real end of the scope yet, and jumping to the last
 *    loaded row would land on an arbitrary page boundary.
 */
function stepAlong(ids, currentId, delta, hasMore) {
  const index = ids.indexOf(currentId);
  if (index < 0) return null;
  const next = ids[index + delta];
  if (next) return { id: next };
  if (hasMore) return delta > 0 ? { more: true } : null;
  const wrapped = ids[delta > 0 ? 0 : ids.length - 1];
  return wrapped && wrapped !== currentId ? { id: wrapped } : null;
}

/**
 * One keypress.
 *
 * Returns:
 *  - `{ id }`           show this asset;
 *  - `{ more: true }`   the current position is the last loaded one and the
 *                       scope has another page: load it, then ask again;
 *  - `null`             nowhere to go (a single row, or the current asset is
 *                       not in this source's list).
 *
 * Up/Down inside a masonry grid walk the current card's own column (what is
 * visually above/below), exactly as the grid's own keyboard navigation does.
 * They fall back to reading order when the grid has not published a column
 * for the current card.
 */
export function resolveStep({ list, columns = [], currentId, key, hasMore = false }) {
  const delta = keyDelta(key);
  if (!delta) return null;
  const order = list.map((candidate) => candidate.id);
  if (!order.includes(currentId)) return null;

  if (isVerticalKey(key)) {
    const navigable = new Set(order);
    const column = columns
      .map((ids) => ids.filter((id) => navigable.has(id)))
      .find((ids) => ids.includes(currentId));
    if (column) return stepAlong(column, currentId, delta, hasMore);
  }
  return stepAlong(order, currentId, delta, hasMore);
}

/**
 * The assets around `currentId` in reading order, nearest first, those in the
 * direction of travel (`direction` +1/-1) before those behind. `ahead` and
 * `behind` bound how far each side reaches.
 */
export function neighbourWindow(list, currentId, direction = 1, { ahead = 2, behind = 1 } = {}) {
  const index = list.findIndex((candidate) => candidate.id === currentId);
  if (index < 0) return [];
  const sign = direction < 0 ? -1 : 1;
  const out = [];
  for (let step = 1; step <= Math.max(ahead, behind); step += 1) {
    const forward = list[index + sign * step];
    const backward = list[index - sign * step];
    if (step <= ahead && forward) out.push(forward);
    if (step <= behind && backward) out.push(backward);
  }
  return out;
}
