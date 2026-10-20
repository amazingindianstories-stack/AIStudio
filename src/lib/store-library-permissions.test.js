import assert from "node:assert/strict";
import test from "node:test";
import { useStore } from "./store";

test("non-admin library deletes and moves reject before optimistic changes or mutation HTTP", async () => {
  const previous = useStore.getState();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    if (options?.method && options.method !== "GET") calls++;
    return new Response(JSON.stringify({ globalFolders: [], projects: [] }));
  };
  try {
    for (const currentUser of [null, { id: "owner", role: "user" }]) {
      const items = [{ id: "owned", userId: "owner" }];
      useStore.setState({ currentUser, items, activeId: "owned", selectedIds: ["owned"] });
      for (const operation of [
        () => useStore.getState().removeItem("owned"),
        () => useStore.getState().deleteGenerations(["owned", "other"]),
        () => useStore.getState().deleteFolder(null, "folder"),
        () => useStore.getState().moveGenerationsToDestination(["owned"], { type: "global_unsorted" }),
      ]) await assert.rejects(operation, /Only admins can/);
      assert.equal(useStore.getState().items, items);
      assert.equal(useStore.getState().activeId, "owned");
      assert.deepEqual(useStore.getState().selectedIds, ["owned"]);
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    useStore.setState(previous, true);
  }
});
