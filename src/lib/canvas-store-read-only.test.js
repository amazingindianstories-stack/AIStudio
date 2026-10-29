import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { useCanvasStore, selectReadOnly } from "./canvas-store.js";
import { readPendingDraft, savePendingDraft } from "./canvas-pending-draft.js";
import { emptyCanvasState } from "./canvas/serialization.js";
import { canEditRole, canOwnRole, canShareRole } from "./board-access.js";
import { CanvasToolbar } from "../components/canvas/CanvasToolbar.jsx";

function useStorage(t) {
  const map = new Map();
  const value = { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
  const had = Object.prototype.hasOwnProperty.call(globalThis, "localStorage");
  const prior = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", { value, configurable: true, writable: true });
  t.after(() => {
    if (had) Object.defineProperty(globalThis, "localStorage", { value: prior, configurable: true, writable: true });
    else delete globalThis.localStorage;
  });
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const node = { id: "n1", type: "sticky", x: 0, y: 0, w: 100, h: 100, text: "hi", fill: "#fde68a", fontSize: 16, color: "#111", opacity: 1, parentId: null, groupId: null };

function boardWithNode() {
  return { ...emptyCanvasState(), nodes: [node] };
}

function serve(t, role, { saveStatus = 200 } = {}) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET" });
    if ((init.method || "GET") === "PUT") return json(saveStatus, saveStatus === 200 ? { ok: true, updatedAt: Date.now() } : { error: "FORBIDDEN" });
    return json(200, { id: "board-1", name: "Board", data: boardWithNode(), updatedAt: 1, role });
  });
  return calls;
}

function tryEveryEdit(store) {
  const s = store.getState();
  s.setSelection(["n1"]);
  s.addNode({ ...node, id: "n2" });
  s.moveSelectionBy(10, 10);
  s.resizeSelected("se", 10, 10, false);
  s.updateSelectedStyle({ text: "changed" });
  s.commitNodeText("n1", "changed", [[0, 1, "b"]]);
  s.duplicateSelected();
  s.duplicateSelectionInPlace();
  s.copy();
  s.paste();
  s.cut();
  s.group();
  s.bringToFront();
  s.addImageBatch([{ url: "/api/media/x.png", naturalW: 10, naturalH: 10 }]);
  s.addImageFromAsset({ url: "/api/media/x.png", aspectRatio: "1:1" });
  s.addConnector({ x: 0, y: 0 }, { x: 5, y: 5 }, "arrow");
  s.deleteSelected();
  s.undo();
  s.redo();
  s.setTool("sticky");
  s.setEditingTextId("n1");
  s.beginCrop("n1");
  s.setViewport({ x: 40, y: 40, zoom: 2 });
}

for (const role of ["view", "comment"]) {
  test(`a ${role}-only board loads read-only: no edits, no autosave, no draft writes`, async (t) => {
    useStorage(t);
    const calls = serve(t, role);
    const store = useCanvasStore;
    store.getState().reset();
    await store.getState().loadBoard("board-1");
    assert.equal(store.getState().boardRole, role);
    assert.equal(selectReadOnly(store.getState()), true);

    tryEveryEdit(store);
    const state = store.getState();
    assert.deepEqual(state.history.present.nodes, [node]);
    assert.deepEqual(state.history.past, []);
    assert.equal(state.tool, "select");
    assert.equal(state.editingTextId, null);
    assert.equal(state.croppingImageId, null);
    assert.equal(state.saveStatus, "idle");
    // Zoom and pan still work locally; they are never saved.
    assert.deepEqual(state.history.present.viewport, { x: 40, y: 40, zoom: 2 });
    store.getState().setTool("hand");
    assert.equal(store.getState().tool, "hand");

    await store.getState().flushSave();
    assert.equal(store.getState().persistPendingDraft(), false);
    assert.equal(readPendingDraft("board-1"), null);
    assert.deepEqual(calls.filter((call) => call.method !== "GET"), []);
    store.getState().reset();
  });
}

test("a read-only load leaves an earlier unsaved draft alone for when edit access returns", async (t) => {
  useStorage(t);
  serve(t, "view");
  const draft = { ...emptyCanvasState(), nodes: [{ ...node, text: "unsaved" }] };
  savePendingDraft("board-1", draft);
  const store = useCanvasStore;
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  assert.deepEqual(store.getState().history.present.nodes, [node]);
  assert.equal(store.getState().saveStatus, "idle");
  assert.deepEqual(readPendingDraft("board-1").data, draft);
  store.getState().reset();
});

test("an editor edits and autosaves as before", async (t) => {
  useStorage(t);
  const calls = serve(t, "edit");
  const store = useCanvasStore;
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  assert.equal(selectReadOnly(store.getState()), false);
  store.getState().addNode({ ...node, id: "n2" });
  assert.equal(store.getState().saveStatus, "dirty");
  await store.getState().flushSave();
  assert.equal(store.getState().saveStatus, "saved");
  assert.equal(calls.filter((call) => call.method === "PUT").length, 1);
  store.getState().reset();
});

test("a save refused with 403 turns the board read-only, keeps the draft and stops retrying", async (t) => {
  useStorage(t);
  const calls = serve(t, "edit", { saveStatus: 403 });
  const store = useCanvasStore;
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  store.getState().addNode({ ...node, id: "n2" });
  const edited = store.getState().history.present;
  await store.getState().flushSave();
  const state = store.getState();
  assert.equal(state.accessLost, true);
  assert.equal(selectReadOnly(state), true);
  assert.equal(state.saveStatus, "idle");
  assert.deepEqual(readPendingDraft("board-1").data, edited);
  store.getState().addNode({ ...node, id: "n3" });
  await store.getState().flushSave();
  assert.equal(calls.filter((call) => call.method === "PUT").length, 1);
  store.getState().reset();
  assert.equal(store.getState().accessLost, false);
});

test("dropping to view access from the share dialog stops editing at once", async (t) => {
  useStorage(t);
  serve(t, "owner");
  const store = useCanvasStore;
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  store.getState().setTool("sticky");
  store.getState().setEditingTextId("n1");
  store.getState().setBoardRole("view");
  assert.equal(store.getState().tool, "select");
  assert.equal(store.getState().editingTextId, null);
  assert.equal(selectReadOnly(store.getState()), true);
  store.getState().reset();
});

test("role helpers follow the server's ranking; an unloaded role is not read-only", () => {
  assert.deepEqual(["view", "comment", "edit", "co_owner", "owner", null].map(canEditRole), [false, false, true, true, true, true]);
  assert.deepEqual(["view", "comment", "edit", "co_owner", "owner", null].map(canShareRole), [false, false, false, true, true, false]);
  assert.deepEqual(["view", "comment", "edit", "co_owner", "owner", null].map(canOwnRole), [false, false, false, false, true, false]);
});

test("the read-only toolbar keeps navigation and zoom but no creation tools", () => {
  const previousReact = globalThis.React;
  globalThis.React = React;
  try {
    const render = (readOnly) => renderToString(React.createElement(CanvasToolbar, { readOnly, toolLocked: false, onToggleLock() {}, onAddImageClick() {} }));
    const editable = render(false);
    const readOnly = render(true);
    for (const label of ["Select", "Hand", "Zoom in", "Zoom out"]) {
      assert.match(readOnly, new RegExp(`aria-label="${label}"`));
    }
    for (const label of ["Sticky note", "Text", "Shapes", "Connector", "Add image"]) {
      assert.match(editable, new RegExp(`aria-label="${label}"`));
      assert.doesNotMatch(readOnly, new RegExp(`aria-label="${label}"`));
    }
  } finally {
    globalThis.React = previousReact;
  }
});

test("touch edit mode: refused on read-only boards, cleared when access drops, ends selection and edits on Done", async (t) => {
  useStorage(t);
  serve(t, "view");
  const store = useCanvasStore.getState();
  store.reset();
  await store.loadBoard("board-1");
  useCanvasStore.getState().setTouchEditMode(true);
  assert.equal(useCanvasStore.getState().touchEditMode, false, "a viewer never gets touch edit mode");

  useCanvasStore.getState().setBoardRole("edit");
  useCanvasStore.getState().setTouchEditMode(true);
  assert.equal(useCanvasStore.getState().touchEditMode, true, "an editor can turn it on");
  useCanvasStore.getState().setSelection(["n1"]);
  useCanvasStore.getState().setEditingTextId("n1");
  useCanvasStore.getState().setTool("sticky");
  useCanvasStore.getState().setTouchEditMode(false);
  const done = useCanvasStore.getState();
  assert.equal(done.touchEditMode, false);
  assert.deepEqual(done.selection, []);
  assert.equal(done.editingTextId, null);
  assert.equal(done.tool, "select", "Done returns to the select tool");

  useCanvasStore.getState().setTouchEditMode(true);
  useCanvasStore.getState().setBoardRole("comment");
  assert.equal(useCanvasStore.getState().touchEditMode, false, "losing edit access leaves edit mode");

  useCanvasStore.getState().setBoardRole("edit");
  useCanvasStore.getState().setTouchEditMode(true);
  await useCanvasStore.getState().loadBoard("board-1");
  assert.equal(useCanvasStore.getState().touchEditMode, false, "every board opens view-only on touch");
  useCanvasStore.getState().reset();
});
