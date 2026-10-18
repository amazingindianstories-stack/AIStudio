import { useStore } from "./store";
import { isVerticalKey, resolveStep, viewerList } from "./viewer-navigation";

/** Wait for AssetGrid to publish its repacked columns after a page append. */
function nextGridColumns(previous, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => {
      unsubscribe();
      resolve();
    }, timeoutMs);
    unsubscribe = useStore.subscribe((state) => {
      if (state.gridColumns === previous) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

/** The list the open viewer navigates, read fresh from the store. */
function liveViewerList(state) {
  if (state.activeSource === "thread") return viewerList("thread", { threadItems: state.threadItems });
  return viewerList("feed", {
    items: state.items.filter(
      (candidate) =>
        state.rightTab !== "project" ||
        !state.activeProjectId ||
        candidate.projectId === state.activeProjectId
    ),
  });
}

/**
 * One arrow press. Walks the list the viewer was opened from; at the end of the
 * loaded page it fetches the next page of the same scope (the grid's own keyset
 * query) and carries on; only once the whole scope is loaded does the end wrap
 * (within that same scope).
 */
export async function stepViewer(key) {
  const MAX_PAGES = 10;
  for (let page = 0; page <= MAX_PAGES; page += 1) {
    const state = useStore.getState();
    if (state.activeSource === "single") return;
    // The grid moved to another scope since the viewer opened: that list is not
    // the one the user is looking at, so there is nothing to walk.
    if (state.activeSource === "feed" && state.feedKey !== state.activeFeedKey) return;
    const target = resolveStep({
      list: liveViewerList(state),
      columns: state.activeSource === "feed" ? state.gridColumns : [],
      currentId: state.activeId,
      key,
      hasMore: state.activeSource === "feed" && state.hasMoreHistory,
    });
    if (!target) return;
    if (target.id) {
      state.setActiveId(target.id, state.activeSource);
      return;
    }
    const before = state.items.length;
    // Up/Down read the grid's columns, which repack a tick after the append.
    const repacked = isVerticalKey(key) ? nextGridColumns(state.gridColumns) : null;
    await state.loadMoreHistory();
    const after = useStore.getState();
    if (after.items.length === before || after.paginationError) return;
    if (after.activeId !== state.activeId || after.feedKey !== state.activeFeedKey) return;
    if (repacked) await repacked;
  }
}
