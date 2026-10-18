import test from "node:test";
import assert from "node:assert/strict";
import { useStore } from "./store.js";
import { disposeStoreRuntime } from "./store-runtime.js";
import { clearFeedCache, putFeedCache } from "./feed-cache.js";
import { scopeKey } from "./feed-scope.js";
import { stepViewer } from "./viewer-step.js";

const row = (id, createdAt, extra = {}) => ({
  id,
  kind: "image",
  status: "succeeded",
  prompt: id,
  url: `/api/media/generations/${id}.jpg`,
  createdAt,
  updatedAt: createdAt,
  folderId: "folder-a",
  projectId: "p1",
  ...extra,
});

const FOLDER_SCOPE = { tab: "project", projectId: "p1", folderId: "folder-a", kind: "all", q: "" };

async function withFolderViewer(t, { items, nextCursor, open, source = "feed" }, run) {
  disposeStoreRuntime();
  clearFeedCache();
  const initial = useStore.getState();
  try {
    useStore.setState({ rightTab: "project", activeProjectId: "p1", activeFolderId: "folder-a", filterKind: "all", search: "" });
    const key = scopeKey(FOLDER_SCOPE);
    putFeedCache(key, { items, nextCursor, at: Date.now() });
    useStore.setState({ items, feedKey: key, hasMoreHistory: nextCursor !== null, gridColumns: [] });
    useStore.getState().setActiveId(open, source);
    await run();
  } finally {
    disposeStoreRuntime();
    clearFeedCache();
    useStore.setState(initial, true);
  }
}

test("arrow steps inside a folder stay inside the folder's list and wrap only within it", async (t) => {
  const items = [row("n3", 300), row("n2", 200), row("n1", 100)];
  await withFolderViewer(t, { items, nextCursor: null, open: "n3" }, async () => {
    const seen = [];
    for (let i = 0; i < 4; i += 1) {
      await stepViewer("ArrowRight");
      seen.push(useStore.getState().activeId);
    }
    // Off the end of the complete folder it wraps to the folder's own first row.
    assert.deepEqual(seen, ["n2", "n1", "n3", "n2"]);
    await stepViewer("ArrowLeft");
    await stepViewer("ArrowLeft");
    assert.equal(useStore.getState().activeId, "n1");
  });
});

test("the end of a loaded page continues into the next page of the same folder query", async (t) => {
  const items = [row("n4", 400), row("n3", 300)];
  await withFolderViewer(t, { items, nextCursor: "cursor-1", open: "n3" }, async () => {
    const urls = [];
    t.mock.method(globalThis, "fetch", async (input) => {
      urls.push(String(input));
      return Response.json({ items: [row("n2", 200), row("n1", 100)], nextCursor: null });
    });
    await stepViewer("ArrowRight");
    assert.equal(useStore.getState().activeId, "n2");
    assert.equal(urls.length, 1);
    const query = new URL(urls[0], "http://x").searchParams;
    assert.equal(query.get("projectId"), "p1");
    assert.equal(query.get("folderId"), "folder-a");
    assert.equal(query.get("cursor"), "cursor-1");
    // Page two was the last: the scope is complete, so the end wraps inside it
    // without another request.
    await stepViewer("ArrowRight");
    assert.equal(useStore.getState().activeId, "n1");
    await stepViewer("ArrowRight");
    assert.equal(useStore.getState().activeId, "n4");
    assert.equal(urls.length, 1);
  });
});

test("a next page with nothing viewable keeps loading until something is, then stops at the true end", async (t) => {
  const items = [row("n5", 500)];
  await withFolderViewer(t, { items, nextCursor: "c1", open: "n5" }, async () => {
    const pages = [
      { items: [row("n4", 400, { status: "failed" })], nextCursor: "c2" },
      { items: [row("n3", 300)], nextCursor: null },
    ];
    let call = 0;
    t.mock.method(globalThis, "fetch", async () => Response.json(pages[call++]));
    await stepViewer("ArrowRight");
    assert.equal(useStore.getState().activeId, "n3");
    assert.equal(call, 2);
  });
});

test("a failed page request leaves the viewer where it was", async (t) => {
  const items = [row("n2", 200)];
  await withFolderViewer(t, { items, nextCursor: "c1", open: "n2" }, async () => {
    t.mock.method(globalThis, "fetch", async () => new Response("nope", { status: 500 }));
    t.mock.method(console, "error", () => {});
    await stepViewer("ArrowRight");
    assert.equal(useStore.getState().activeId, "n2");
  });
});

test("a viewer opened from the grid does not reach into another scope the grid has moved to", async (t) => {
  const items = [row("n2", 200), row("n1", 100)];
  await withFolderViewer(t, { items, nextCursor: null, open: "n2" }, async () => {
    // The grid switched scope underneath; its list is no longer the one opened from.
    useStore.setState({ items: [row("other", 999, { folderId: null })], feedKey: "folder:other:all:" });
    await stepViewer("ArrowRight");
    assert.equal(useStore.getState().activeId, "n2");
  });
});

test("a thread viewer walks the thread in drawn order and ignores the grid's folder scope", async (t) => {
  const items = [row("f2", 200), row("f1", 100)];
  await withFolderViewer(t, { items, nextCursor: null, open: "t2", source: "thread" }, async () => {
    // loaded newest first; drawn oldest first: t1 t2 t3
    useStore.setState({ threadItems: [row("t3", 30, { folderId: null }), row("t2", 20), row("t1", 10, { folderId: "folder-b" })] });
    await stepViewer("ArrowRight");
    assert.equal(useStore.getState().activeId, "t3");
    await stepViewer("ArrowRight");
    assert.equal(useStore.getState().activeId, "t1"); // wraps inside the thread, never into the grid's rows
    await stepViewer("ArrowLeft");
    assert.equal(useStore.getState().activeId, "t3");
    assert.equal(useStore.getState().activeSource, "thread");
  });
});

test("a single card never navigates", async (t) => {
  const items = [row("n2", 200), row("n1", 100)];
  await withFolderViewer(t, { items, nextCursor: null, open: "n2", source: "single" }, async () => {
    await stepViewer("ArrowRight");
    assert.equal(useStore.getState().activeId, "n2");
  });
});

test("closing the viewer resets its source", () => {
  const initial = useStore.getState();
  try {
    useStore.getState().setActiveId("x", "thread");
    assert.equal(useStore.getState().activeSource, "thread");
    useStore.getState().setActiveId(null);
    assert.equal(useStore.getState().activeSource, "feed");
    assert.equal(useStore.getState().activeFeedKey, "");
  } finally {
    useStore.setState(initial, true);
  }
});
