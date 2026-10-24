import test from "node:test";
import assert from "node:assert/strict";
import { useStore } from "./store.js";
import { emptyLibraryFilters } from "./library-filters.js";

test("scope change reconciliation: setActiveProject clears selection", () => {
  useStore.setState({
    activeProjectId: "proj-1",
    selectedIds: ["asset-1", "asset-2"],
    focusedAssetId: "asset-1",
    selectionAnchorId: "asset-1",
  });

  useStore.getState().setActiveProject("proj-2");

  const state = useStore.getState();
  assert.equal(state.activeProjectId, "proj-2");
  assert.deepEqual(state.selectedIds, []);
  assert.equal(state.focusedAssetId, null);
  assert.equal(state.selectionAnchorId, null);
});

test("scope change reconciliation: setActiveFolder clears selection", () => {
  useStore.setState({
    activeFolderId: "folder-1",
    selectedIds: ["asset-3"],
    focusedAssetId: "asset-3",
    selectionAnchorId: "asset-3",
  });

  useStore.getState().setActiveFolder("folder-2");

  const state = useStore.getState();
  assert.equal(state.activeFolderId, "folder-2");
  assert.deepEqual(state.selectedIds, []);
  assert.equal(state.focusedAssetId, null);
  assert.equal(state.selectionAnchorId, null);
});

test("scope change reconciliation: setRightTab clears selection", () => {
  useStore.setState({
    rightTab: "project",
    selectedIds: ["asset-4"],
    focusedAssetId: "asset-4",
    selectionAnchorId: "asset-4",
  });

  useStore.getState().setRightTab("global");

  const state = useStore.getState();
  assert.equal(state.rightTab, "global");
  assert.deepEqual(state.selectedIds, []);
  assert.equal(state.focusedAssetId, null);
  assert.equal(state.selectionAnchorId, null);
});

test("scope change reconciliation: setSearch clears selection when query changes", () => {
  useStore.setState({
    search: "car",
    selectedIds: ["asset-5"],
    focusedAssetId: "asset-5",
    selectionAnchorId: "asset-5",
  });

  useStore.getState().setSearch("boat");

  const state = useStore.getState();
  assert.equal(state.search, "boat");
  assert.deepEqual(state.selectedIds, []);
  assert.equal(state.focusedAssetId, null);
  assert.equal(state.selectionAnchorId, null);
});

test("scope change reconciliation: setLibraryFilters clears selection when the Type filter changes", () => {
  useStore.setState({
    libraryFilters: emptyLibraryFilters(),
    selectedIds: ["asset-6"],
    focusedAssetId: "asset-6",
    selectionAnchorId: "asset-6",
  });

  useStore.getState().setLibraryFilters({ ...emptyLibraryFilters(), types: ["video"] });

  const state = useStore.getState();
  assert.deepEqual(state.libraryFilters.types, ["video"]);
  assert.deepEqual(state.selectedIds, []);
  assert.equal(state.focusedAssetId, null);
  assert.equal(state.selectionAnchorId, null);
});

test("infinite scroll appends items without clearing active selection in same scope", () => {
  useStore.setState({
    items: [{ id: "asset-1" }, { id: "asset-2" }],
    selectedIds: ["asset-1"],
    focusedAssetId: "asset-1",
    selectionAnchorId: "asset-1",
  });

  // Simulate appending new page of items to items list
  useStore.setState((st) => ({
    items: [...st.items, { id: "asset-3" }, { id: "asset-4" }],
  }));

  const state = useStore.getState();
  assert.equal(state.items.length, 4);
  assert.deepEqual(state.selectedIds, ["asset-1"], "Selection must be preserved during infinite scroll append");
  assert.equal(state.focusedAssetId, "asset-1");
  assert.equal(state.selectionAnchorId, "asset-1");
});

test("idempotent scope calls with same value preserve selection", () => {
  useStore.setState({
    search: "same-query",
    activeProjectId: "p-stay",
    selectedIds: ["asset-keep"],
    focusedAssetId: "asset-keep",
  });

  useStore.getState().setSearch("same-query");
  useStore.getState().setActiveProject("p-stay");

  const state = useStore.getState();
  assert.deepEqual(state.selectedIds, ["asset-keep"]);
  assert.equal(state.focusedAssetId, "asset-keep");
});
