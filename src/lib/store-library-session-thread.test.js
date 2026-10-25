import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { emptyLibraryFilters } from "./library-filters.js";

test("a folder or project switch on a navigation tab reloads the chat for the newly open folder", async (t) => {
  const dom = new JSDOM("", { url: "http://localhost" });
  const prior = { window: globalThis.window, fetch: globalThis.fetch };
  globalThis.window = dom.window;
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(new URL(String(url), "http://localhost"));
    return Response.json({ items: [], nextCursor: null, total: 0, assets: [] });
  };
  const { useStore } = await import("./store.js");
  const { disposeStoreRuntime } = await import("./store-runtime.js");
  const original = useStore.getState();
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const threadRequests = () => calls.filter(url => url.pathname === "/api/history" && url.searchParams.get("limit") === "60");
  const assetRequests = () => calls.filter(url => url.pathname === "/api/assets");
  try {
    useStore.setState({ rightTab: "project", activeProjectId: "p1", activeFolderId: "a", search: "", libraryFilters: emptyLibraryFilters() });
    await settle();

    calls.length = 0;
    useStore.setState({ activeFolderId: "b" });
    await settle();
    assert.deepEqual(threadRequests().map(url => [url.searchParams.get("projectId"), url.searchParams.get("folderId")]), [["p1", "b"]]);
    assert.deepEqual(assetRequests(), []);

    calls.length = 0;
    useStore.setState({ activeProjectId: "p2", activeFolderId: "c" });
    await settle();
    assert.deepEqual(threadRequests().map(url => [url.searchParams.get("projectId"), url.searchParams.get("folderId")]), [["p2", "c"]]);
    assert.deepEqual(assetRequests().map(url => url.searchParams.get("projectId")), ["p2"]);
  } finally {
    disposeStoreRuntime();
    useStore.setState(original, true);
    Object.assign(globalThis, prior);
    dom.window.close();
    t.mock.restoreAll();
  }
});
