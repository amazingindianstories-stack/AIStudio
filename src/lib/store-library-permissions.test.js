import assert from "node:assert/strict";
import test from "node:test";
import { useStore } from "./store";
import { clearFeedCache, putFeedCache } from "./feed-cache.js";
import { scopeKey } from "./feed-scope.js";

const FORBIDDEN = {
  "DELETE /api/history": { error: "Only admins can delete generations." },
  "DELETE /api/folders": { error: "Only admins can delete folders.", code: "FORBIDDEN" },
  "POST /api/history/move": { error: "Only admins can move generations." },
};

test("server 403s on library deletes and moves reach the caller as short clear errors", async () => {
  const previous = useStore.getState();
  const originalFetch = globalThis.fetch;
  const mutations = [];
  globalThis.fetch = async (url, options) => {
    const method = options?.method || "GET";
    const path = new URL(String(url), "http://veevee.test").pathname;
    const body = FORBIDDEN[`${method} ${path}`];
    if (body) {
      mutations.push(`${method} ${path}`);
      return new Response(JSON.stringify(body), { status: 403 });
    }
    return new Response(JSON.stringify({ globalFolders: [], projects: [] }));
  };
  try {
    useStore.setState({ currentUser: { id: "owner", role: "user" }, items: [{ id: "owned", userId: "owner" }] });
    const store = useStore.getState();
    assert.deepEqual(await store.removeItem("owned"), { ok: false, error: "You don't have permission to delete this." });
    await assert.rejects(store.deleteGenerations(["owned", "other"]), { message: "You don't have permission to delete this." });
    await assert.rejects(store.deleteFolder(null, "folder"), { message: "You don't have permission to do that." });
    await assert.rejects(
      store.moveGenerationsToDestination(["owned"], { type: "global_unsorted" }),
      { message: "Only admins can move generations." },
    );
    assert.deepEqual(mutations, [
      "DELETE /api/history",
      "DELETE /api/history",
      "DELETE /api/history",
      "DELETE /api/folders",
      "POST /api/history/move",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    useStore.setState(previous, true);
  }
});

async function bulkDelete(ids, failing, selectedIds = ids) {
  const previous = useStore.getState();
  const originalFetch = globalThis.fetch;
  const seen = { deleted: [], counts: 0, feed: 0, inFlight: 0, maxInFlight: 0 };
  globalThis.fetch = async (url, options) => {
    const address = new URL(String(url), "http://veevee.test");
    if (options?.method === "DELETE" && address.pathname === "/api/history") {
      const id = address.searchParams.get("id");
      seen.deleted.push(id);
      seen.inFlight++;
      seen.maxInFlight = Math.max(seen.maxInFlight, seen.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      seen.inFlight--;
      return failing[id]
        ? new Response(JSON.stringify(failing[id].body), { status: failing[id].status })
        : new Response(JSON.stringify({ ok: true }));
    }
    if (address.pathname === "/api/history/counts") seen.counts++;
    else if (address.pathname === "/api/history") seen.feed++;
    return new Response(JSON.stringify({ items: [], nextCursor: null }));
  };
  try {
    const items = ids.map((id) => ({ id }));
    const key = scopeKey({ tab: "history", projectId: null, folderId: null, kind: "all", q: "" });
    putFeedCache(key, { items, nextCursor: null, at: 0 });
    useStore.setState({ currentUser: { id: "admin", role: "admin" }, rightTab: "history", activeProjectId: null,
      activeFolderId: null, search: "", items, feedKey: key, selectedIds });
    const pending = useStore.getState().deleteGenerations(ids);
    useStore.setState((s) => ({ selectedIds: [...s.selectedIds, "picked-during-delete"] }));
    try {
      const result = await pending;
      return { ...seen, result, selectedIds: useStore.getState().selectedIds };
    } catch (error) {
      return { ...seen, error: error.message, selectedIds: useStore.getState().selectedIds };
    }
  } finally {
    globalThis.fetch = originalFetch;
    clearFeedCache();
    useStore.setState(previous, true);
  }
}

test("bulk delete bounds concurrent deletes and refreshes counts once without reloading the feed", async () => {
  const ids = Array.from({ length: 12 }, (_, index) => `item-${index}`);
  const seen = await bulkDelete(ids, {}, [...ids, "kept"]);
  assert.equal(seen.result, true);
  assert.deepEqual(seen.selectedIds, ["kept", "picked-during-delete"]);
  assert.deepEqual([...seen.deleted].sort(), [...ids].sort());
  assert.ok(seen.maxInFlight > 1 && seen.maxInFlight <= 4, `max in flight ${seen.maxInFlight}`);
  assert.deepEqual({ counts: seen.counts, feed: seen.feed }, { counts: 1, feed: 0 });
});

test("a partly failed bulk delete finishes the batch, refreshes once and reports the first failure", async () => {
  const ids = ["done", "running", "forbidden", "later"];
  const seen = await bulkDelete(ids, {
    running: { status: 409, body: { error: "GENERATION_REQUIRES_RECONCILIATION" } },
    forbidden: { status: 403, body: { error: "Only admins can delete generations." } },
  });
  assert.equal(seen.error, "This generation is still rendering. Wait for it to finish, then delete it.");
  assert.deepEqual(seen.selectedIds, ["running", "forbidden", "picked-during-delete"]);
  assert.deepEqual([...seen.deleted].sort(), [...ids].sort());
  assert.deepEqual({ counts: seen.counts, feed: seen.feed }, { counts: 1, feed: 1 });
});

test("a forbidden bulk delete reports a short permission message", async () => {
  const seen = await bulkDelete(["a", "b"], {
    a: { status: 403, body: { error: "Only admins can delete generations." } },
    b: { status: 403, body: { error: "Only admins can delete generations." } },
  });
  assert.equal(seen.error, "You don't have permission to delete this.");
  assert.deepEqual({ counts: seen.counts, feed: seen.feed }, { counts: 1, feed: 1 });
});
