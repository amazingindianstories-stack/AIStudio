/**
 * Locking objects and board layers through the board store: who may lock,
 * protect and unlock, that locked objects stay put through delete and nudge,
 * the personal hide/active layer state, and a save the server corrected
 * (its response carries the board it kept) merging back into the editor.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { useCanvasStore } from "./canvas-store.js";
import { emptyCanvasState } from "./canvas/serialization.js";
import { applyBoardPatch } from "./canvas/patch.js";
import { isLocked } from "./canvas/locks.js";
import { layersOf } from "./canvas/layers.js";
import { hasUnlockable, selectionLockState } from "./canvas/lock-state.js";

const store = useCanvasStore;
const ME = "7";
const OTHER = "9";

function stubStorage(t) {
  const map = new Map();
  const value = { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
  const had = Object.prototype.hasOwnProperty.call(globalThis, "localStorage");
  const prior = globalThis.localStorage;
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, "window");
  Object.defineProperty(globalThis, "localStorage", { value, configurable: true, writable: true });
  if (!hadWindow) globalThis.window = globalThis;
  t.after(() => {
    if (had) Object.defineProperty(globalThis, "localStorage", { value: prior, configurable: true, writable: true });
    else delete globalThis.localStorage;
    if (!hadWindow) delete globalThis.window;
  });
  return map;
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const rect = (id, extra = {}) => ({ id, type: "rect", x: 0, y: 0, w: 10, h: 10, parentId: null, groupId: null, fill: "#ffffff", stroke: "#000000", strokeWidth: 1, cornerRadius: 0, ...extra });
const graph = (nodes, settings) => ({ ...emptyCanvasState(), nodes, ...(settings ? { settings } : {}) });
const ids = (state) => state.nodes.map((n) => n.id);
const nodeOf = (id) => store.getState().history.present.nodes.find((n) => n.id === id);

/** A board endpoint for `role`; `correct` turns a saved graph into the one the server keeps (as locks.enforce does). */
function serve(t, data, { role = "edit", correct = null } = {}) {
  const server = { version: 1, data, saves: [] };
  const board = () => ({ id: "board-1", projectId: "p", name: "Board", createdBy: null, createdAt: 1, updatedAt: server.version, version: server.version, data: server.data, role });
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    if (init.method === "PUT" || init.method === "PATCH") {
      const body = JSON.parse(init.body);
      const sent = init.method === "PUT" ? body.data : applyBoardPatch(server.data, body.patch);
      server.saves.push(sent);
      if (body.baseVersion !== server.version) return json(409, { error: "VERSION_CONFLICT", board: board() });
      const kept = correct ? correct(sent) : null;
      server.data = kept ?? sent;
      server.version += kept ? 2 : 1;
      return json(200, { ok: true, version: server.version, updatedAt: server.version, stamps: {}, ...(kept ? { board: kept } : {}) });
    }
    if (String(url).endsWith("/version")) return json(200, { version: server.version, updatedAt: server.version });
    return json(200, board());
  });
  t.after(() => store.getState().reset());
  return server;
}

async function open(t, data, options) {
  stubStorage(t);
  const server = serve(t, data, options);
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  return server;
}

test("Lock names the person, survives delete and nudge, and is one undo step", async (t) => {
  await open(t, graph([rect("a"), rect("b")]));
  store.getState().setSelection(["a"]);
  store.getState().lockSelection(ME);
  assert.deepEqual(
    { locked: nodeOf("a").locked, lockedBy: nodeOf("a").lockedBy, lockProtected: nodeOf("a").lockProtected },
    { locked: true, lockedBy: ME, lockProtected: undefined }
  );

  store.getState().setSelection(["a", "b"]);
  store.getState().moveSelectionBy(5, 0);
  assert.equal(nodeOf("a").x, 0, "a locked object is not nudged");
  assert.equal(nodeOf("b").x, 5, "the unlocked one in the same selection still moves");
  store.getState().deleteSelected();
  assert.deepEqual(ids(store.getState().history.present), ["a"], "delete leaves the locked object");

  store.getState().undo();
  store.getState().undo();
  assert.deepEqual(ids(store.getState().history.present), ["a", "b"]);
  store.getState().undo();
  assert.equal(nodeOf("a").locked, undefined, "undo lifts the lock");
});

test("Cmd+Shift+L locks a partly locked selection and unlocks a fully locked one", async (t) => {
  await open(t, graph([rect("a", { locked: true, lockedBy: ME }), rect("b")]));
  store.getState().setSelection(["a", "b"]);
  store.getState().toggleLockSelection(ME);
  assert.ok(nodeOf("a").locked && nodeOf("b").locked);
  store.getState().toggleLockSelection(ME);
  assert.equal(nodeOf("a").locked, undefined);
  assert.equal(nodeOf("b").locked, undefined);
  store.getState().setSelection([]);
  const before = store.getState().history.present;
  store.getState().toggleLockSelection(ME);
  assert.equal(store.getState().history.present, before, "nothing selected changes nothing");
});

test("only owners and co-owners set a protected lock; an editor's protect is a plain lock", async (t) => {
  await open(t, graph([rect("a")]), { role: "edit" });
  store.getState().setSelection(["a"]);
  assert.equal(selectionLockState(store.getState().history.present, ["a"], ME, "edit").canProtect, false);
  store.getState().lockSelection(ME, { protect: true });
  assert.equal(nodeOf("a").lockProtected, undefined);
  assert.equal(nodeOf("a").locked, true);
  store.getState().reset();

  await open(t, graph([rect("a")]), { role: "co_owner" });
  store.getState().setSelection(["a"]);
  assert.equal(selectionLockState(store.getState().history.present, ["a"], ME, "co_owner").canProtect, true);
  store.getState().lockSelection(ME, { protect: true });
  assert.deepEqual([nodeOf("a").lockedBy, nodeOf("a").lockProtected], [ME, true]);
  const state = selectionLockState(store.getState().history.present, ["a"], ME, "co_owner");
  assert.equal(state.canProtect, false, "already protected by me");
  assert.equal(state.canUnlock, true);
  assert.equal(state.heldBy, null, "my own protected lock names no one else");
});

test("someone else's protected lock cannot be lifted by unlock, toggle or Unlock all", async (t) => {
  const held = rect("held", { locked: true, lockedBy: OTHER, lockProtected: true });
  await open(t, graph([held, rect("plain", { locked: true, lockedBy: OTHER })]), { role: "co_owner" });
  const present = () => store.getState().history.present;

  const lock = selectionLockState(present(), ["held"], ME, "co_owner");
  assert.deepEqual([lock.canUnlock, lock.canProtect, lock.heldBy, lock.allLocked], [false, false, OTHER, true]);

  store.getState().setSelection(["held"]);
  store.getState().unlockSelection(ME);
  store.getState().toggleLockSelection(ME);
  store.getState().lockSelection(ME, { protect: true });
  assert.deepEqual(nodeOf("held"), held, "no lock action changes it");

  assert.equal(hasUnlockable(present(), ME), true);
  store.getState().unlockAll(ME);
  assert.equal(nodeOf("plain").locked, undefined, "Unlock all lifts plain locks, whoever set them");
  assert.deepEqual(nodeOf("held"), held);
  assert.equal(hasUnlockable(present(), ME), false);
  assert.equal(hasUnlockable(present(), OTHER), true, "the person who set it still can");
});

test("viewers and commenters cannot lock or change layers", async (t) => {
  for (const role of ["view", "comment"]) {
    await open(t, graph([rect("a")], { layers: [{ id: "L", name: "Top" }] }), { role });
    const before = store.getState().history.present;
    store.getState().setSelection(["a"]);
    store.getState().lockSelection(ME);
    store.getState().addLayer();
    store.getState().renameLayer("L", "Renamed");
    store.getState().setLayerLocked("L", true);
    store.getState().deleteLayer("L");
    store.getState().moveSelectionToLayer("L");
    assert.equal(store.getState().history.present, before, role);
    // Hiding is personal, so it still works.
    store.getState().setLayerHidden("L", true);
    assert.deepEqual(store.getState().hiddenLayerIds, ["L"]);
    store.getState().reset();
  }
});

test("a new layer is active and new objects land on it; locked layers lock their objects", async (t) => {
  await open(t, graph([rect("a")]));
  const id = store.getState().addLayer();
  assert.equal(typeof id, "string");
  assert.equal(store.getState().activeLayerId, id);
  assert.deepEqual(layersOf(store.getState().history.present).map((l) => l.name), ["Layer 2"]);
  store.getState().addNode(rect("new"));
  assert.equal(nodeOf("new").layerId, id);

  store.getState().setLayerLocked(id, true);
  assert.equal(isLocked(store.getState().history.present, "new"), true);
  store.getState().setSelection(["new"]);
  store.getState().deleteSelected();
  assert.ok(nodeOf("new"), "an object on a locked layer is not deleted");
  const lock = selectionLockState(store.getState().history.present, ["new"], ME, "edit");
  assert.deepEqual([lock.allLocked, lock.onLockedLayer, lock.canUnlock], [true, true, false]);
});

test("hiding a layer is personal: it drops hidden objects from the selection and Select all, and is remembered", async (t) => {
  const storage = stubStorage(t);
  serve(t, graph([rect("a"), rect("b", { layerId: "L" })], { layers: [{ id: "L", name: "Top" }] }));
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  store.getState().setActiveLayer("L");
  store.getState().setSelection(["a", "b"]);
  const before = store.getState().history.present;
  store.getState().setLayerHidden("L", true);
  assert.equal(store.getState().history.present, before, "hiding changes no board data");
  assert.deepEqual(store.getState().selection, ["a"]);
  assert.equal(store.getState().activeLayerId, null, "a hidden layer stops being the active one");
  store.getState().selectAll();
  assert.deepEqual(store.getState().selection, ["a"]);
  assert.equal(store.getState().saveStatus === "dirty", false);
  assert.equal(storage.get("veevee.board.hiddenLayers.board-1"), JSON.stringify(["L"]));

  store.getState().setLayerHidden("L", false);
  store.getState().setLayerHidden("L", true);
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  assert.deepEqual(store.getState().hiddenLayerIds, ["L"], "reopening the board keeps it hidden");
});

test("Move selection here skips locked objects; reorder, duplicate and delete change the board", async (t) => {
  const layers = [{ id: "L1", name: "One" }, { id: "L2", name: "Two" }];
  await open(t, graph([rect("a"), rect("b", { locked: true }), rect("c", { layerId: "L1" })], { layers }));
  store.getState().setSelection(["a", "b"]);
  store.getState().moveSelectionToLayer("L2");
  assert.equal(nodeOf("a").layerId, "L2");
  assert.equal(nodeOf("b").layerId, undefined);
  store.getState().moveSelectionToLayer(null);
  assert.equal(nodeOf("a").layerId, undefined, "null moves it to the default layer");

  store.getState().moveLayer("L1", 1);
  assert.deepEqual(layersOf(store.getState().history.present).map((l) => l.id), ["L2", "L1"]);

  store.getState().duplicateLayer("L1");
  const after = layersOf(store.getState().history.present);
  assert.deepEqual(after.map((l) => l.name), ["Two", "One", "One copy"]);
  const copyId = after[2].id;
  assert.equal(store.getState().activeLayerId, copyId);
  const copies = store.getState().history.present.nodes.filter((n) => n.layerId === copyId);
  assert.equal(copies.length, 1);
  assert.notEqual(copies[0].id, "c");

  store.getState().deleteLayer(copyId);
  assert.equal(store.getState().activeLayerId, null);
  assert.deepEqual(ids(store.getState().history.present), ["a", "b", "c"], "deleting a layer deletes its objects");
  store.getState().undo();
  assert.equal(store.getState().history.present.nodes.filter((n) => n.layerId === copyId).length, 1, "undo restores them");
});

test("a locked layer is not deleted, and deleting a layer keeps its locked objects on the default layer", async (t) => {
  const layers = [{ id: "L", name: "Top" }, { id: "K", name: "Kept", locked: true }];
  const held = rect("held", { layerId: "L", locked: true, lockedBy: OTHER, lockProtected: true });
  await open(t, graph([rect("free", { layerId: "L" }), rect("plain", { layerId: "L", locked: true }), held, rect("k", { layerId: "K" })], { layers }));
  const before = store.getState().history.present;
  store.getState().setLayerHidden("K", true);
  store.getState().deleteLayer("K");
  assert.equal(store.getState().history.present, before, "a locked layer stays with everything on it");
  assert.deepEqual(store.getState().hiddenLayerIds, ["K"], "and stays hidden for this person");

  store.getState().deleteLayer("L");
  assert.deepEqual(layersOf(store.getState().history.present).map((l) => l.id), ["K"]);
  assert.deepEqual(ids(store.getState().history.present), ["plain", "held", "k"], "only the unlocked object is deleted");
  assert.equal(nodeOf("plain").layerId, undefined);
  const { layerId: _layer, ...heldOnDefault } = held;
  assert.deepEqual(nodeOf("held"), heldOnDefault, "a protected object keeps its lock on the default layer");
});

test("duplicating a layer copies its objects without their locks", async (t) => {
  const layers = [{ id: "L", name: "Top" }];
  const held = rect("held", { layerId: "L", locked: true, lockedBy: OTHER, lockProtected: true });
  await open(t, graph([held, rect("plain", { layerId: "L", locked: true, lockedBy: ME })], { layers }));
  store.getState().duplicateLayer("L");
  const copyId = layersOf(store.getState().history.present)[1].id;
  const copies = store.getState().history.present.nodes.filter((n) => n.layerId === copyId);
  assert.equal(copies.length, 2);
  for (const copy of copies) {
    assert.deepEqual([copy.locked, copy.lockedBy, copy.lockProtected], [undefined, undefined, undefined]);
    assert.equal(isLocked(store.getState().history.present, copy), false, "the copier may change the copy");
  }
  assert.deepEqual(nodeOf("held"), held, "the original keeps its lock");
});

test("a save the server corrected merges its board back and is not saved again", async (t) => {
  const held = rect("held", { x: 0, locked: true, lockedBy: OTHER, lockProtected: true });
  const server = await open(t, graph([held, rect("free")]), {
    // As apps.canvas.locks.enforce: the protected node goes back to what was stored.
    correct: (sent) => {
      const stored = sent.nodes.find((n) => n.id === "held");
      if (stored && stored.x === 0 && stored.locked) return null;
      return { ...sent, nodes: [held, ...sent.nodes.filter((n) => n.id !== "held")] };
    },
  });
  // An out-of-date editor (or another tab) changed the protected object along with an allowed change.
  store.setState((s) => ({
    history: { ...s.history, present: { ...s.history.present, nodes: s.history.present.nodes.map((n) => (n.id === "held" ? { ...n, x: 50 } : n)) } },
  }));
  store.getState().setSelection(["free"]);
  store.getState().moveSelectionBy(10, 0);
  await store.getState().flushSave();

  assert.equal(server.saves.length, 1);
  assert.equal(nodeOf("held").x, 0, "the server's copy of the protected object is put back");
  assert.equal(nodeOf("free").x, 10, "the allowed change stays");
  assert.equal(store.getState().serverVersion, 3, "the corrected save's version is adopted");
  assert.equal(store.getState().saveStatus, "saved");
});
