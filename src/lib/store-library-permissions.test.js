import assert from "node:assert/strict";
import test from "node:test";
import { useStore } from "./store";

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

test("a partly failed bulk delete reports the failed item instead of resolving silently", async () => {
  const previous = useStore.getState();
  const originalFetch = globalThis.fetch;
  const deleted = [];
  globalThis.fetch = async (url, options) => {
    const address = new URL(String(url), "http://veevee.test");
    if (options?.method === "DELETE" && address.pathname === "/api/history") {
      const id = address.searchParams.get("id");
      deleted.push(id);
      return id === "running"
        ? new Response(JSON.stringify({ error: "GENERATION_REQUIRES_RECONCILIATION" }), { status: 409 })
        : new Response(JSON.stringify({ ok: true }));
    }
    return new Response(JSON.stringify({ globalFolders: [], projects: [] }));
  };
  try {
    useStore.setState({ currentUser: { id: "admin", role: "admin" }, items: [{ id: "done" }, { id: "running" }] });
    await assert.rejects(useStore.getState().deleteGenerations(["done", "running"]), {
      message: "This generation is still rendering. Wait for it to finish, then delete it.",
    });
    assert.deepEqual(deleted, ["done", "running"]);
  } finally {
    globalThis.fetch = originalFetch;
    useStore.setState(previous, true);
  }
});
