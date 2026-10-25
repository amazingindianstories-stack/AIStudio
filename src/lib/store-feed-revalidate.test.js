import test from "node:test";
import assert from "node:assert/strict";
import { useStore } from "./store.js";
import { disposeStoreRuntime } from "./store-runtime.js";
import { clearFeedCache, getCached, putFeedCache } from "./feed-cache.js";
import { scopeKey } from "./feed-scope.js";

const row = (id, createdAt, extra = {}) => ({ id, kind: "image", status: "succeeded", prompt: id, createdAt, updatedAt: createdAt, ...extra });

test("revalidating the visible scope keeps loaded pages beyond page 1", async (t) => {
  disposeStoreRuntime();
  clearFeedCache();
  const initial = useStore.getState();
  try {
    useStore.setState({ rightTab: "history", activeProjectId: null, activeFolderId: null, search: "" });
    const scope = { tab: "history", projectId: null, folderId: null, kind: "all", q: "" };
    const key = scopeKey(scope);
    const loaded = [row("n4", 400), row("n3", 300), row("n2", 200), row("n1", 100)];
    putFeedCache(key, { items: loaded, nextCursor: "deep-cursor", at: 0 });
    useStore.setState({ items: loaded, feedKey: key });
    t.mock.method(globalThis, "fetch", async () => Response.json({ items: [row("n5", 500), row("n4", 400, { prompt: "edited" })], nextCursor: "page1-cursor" }));
    await useStore.getState().loadFeed({ force: true });
    const ids = useStore.getState().items.map((i) => i.id);
    assert.deepEqual(ids, ["n5", "n4", "n3", "n2", "n1"]);
    assert.equal(useStore.getState().items[1].prompt, "edited");
    assert.equal(getCached(key).nextCursor, "deep-cursor");
  } finally {
    disposeStoreRuntime();
    clearFeedCache();
    useStore.setState(initial, true);
  }
});
