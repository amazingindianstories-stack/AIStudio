import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { emptyLibraryFilters } from "./library-filters.js";

test("a day-clock tick keeps selection and skips refetch unless a relative date preset is applied", async (t) => {
  const dom = new JSDOM("", { url: "http://localhost" });
  const prior = { window: globalThis.window, fetch: globalThis.fetch };
  globalThis.window = dom.window;
  const calls = [];
  globalThis.fetch = async url => { calls.push(String(url)); return Response.json({ items: [], nextCursor: null, total: 0 }); };
  const { useStore } = await import("./store.js");
  const { disposeStoreRuntime } = await import("./store-runtime.js");
  const original = useStore.getState();
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const selection = { selectedIds: ["a"], focusedAssetId: "a", selectionAnchorId: "a" };
  const today = new Date(2026, 9, 24, 23, 59).getTime(), tomorrow = new Date(2026, 9, 25, 0, 1).getTime();
  try {
    useStore.setState({ rightTab: "history", activeProjectId: null, activeFolderId: null, search: "", libraryFilters: emptyLibraryFilters(), libraryDateNow: today });
    await settle();
    useStore.setState(selection);
    calls.length = 0;
    useStore.getState().setLibraryDateNow(tomorrow);
    await settle();
    assert.deepEqual(useStore.getState().selectedIds, ["a"]);
    assert.equal(useStore.getState().focusedAssetId, "a");
    assert.deepEqual(calls, []);

    useStore.getState().setLibraryFilters({ ...emptyLibraryFilters(), date: "custom", from: "2026-10-01", through: "2026-10-20" });
    await settle();
    useStore.setState(selection);
    calls.length = 0;
    useStore.getState().setLibraryDateNow(today);
    await settle();
    assert.deepEqual(useStore.getState().selectedIds, ["a"]);
    assert.deepEqual(calls, []);

    useStore.getState().setLibraryFilters({ ...emptyLibraryFilters(), date: "today" });
    await settle();
    useStore.setState(selection);
    calls.length = 0;
    useStore.getState().setLibraryDateNow(tomorrow);
    await settle();
    assert.deepEqual(useStore.getState().selectedIds, []);
    assert.equal(useStore.getState().focusedAssetId, null);
    assert.ok(calls.some(url => url.startsWith("/api/history?") && url.includes("createdFrom=")));
  } finally {
    disposeStoreRuntime();
    useStore.setState(original, true);
    Object.assign(globalThis, prior);
    dom.window.close();
    t.mock.restoreAll();
  }
});
