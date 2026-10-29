import assert from "node:assert/strict";
import test from "node:test";
import { useCanvasStore } from "./canvas-store.js";
import { DRAFT_SYNC_MAX_AGE_MS, readPendingDraft, savePendingDraft } from "./canvas-pending-draft.js";
import { emptyCanvasState } from "./canvas/serialization.js";

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
const rect = (id, extra = {}) => ({ id, type: "rect", x: 0, y: 0, w: 10, h: 10, parentId: null, groupId: null, fill: "#ffffff", stroke: "#000000", strokeWidth: 1, cornerRadius: 0, ...extra });
const graph = (...nodes) => ({ ...emptyCanvasState(), nodes });
const ids = (state) => state.nodes.map((node) => node.id);
const store = useCanvasStore;

/** A board endpoint with the server's conditional-save contract; `edit` is another person's save. */
function fakeServer(t, data) {
  const server = { version: 1, data, applied: new Map(), puts: [], boardUrls: [], versionReads: 0, boardReads: 0, holdPut: null, dropResponse: false };
  const board = () => ({ id: "board-1", projectId: "p", name: "Board", createdBy: null, createdAt: 1, updatedAt: server.version,
    version: server.version, data: server.data });
  server.edit = (next) => { server.data = next; server.version += 1; };
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    if (url.endsWith("/version")) {
      server.versionReads += 1;
      return json(200, { version: server.version, updatedAt: server.version });
    }
    if (init.method === "PUT") {
      const body = JSON.parse(init.body);
      server.puts.push(body);
      if (server.holdPut) await server.holdPut;
      if (body.baseVersion !== server.version || typeof body.saveId !== "string") {
        return json(409, { error: "VERSION_CONFLICT", board: board() });
      }
      server.edit(body.data);
      server.applied.set(body.saveId, server.version);
      if (server.dropResponse) throw new TypeError("Failed to fetch");
      return json(200, { ok: true, updatedAt: server.version, version: server.version });
    }
    server.boardReads += 1;
    server.boardUrls.push(url);
    const saveId = new URL(url, "http://veevee.test").searchParams.get("saveId");
    return json(200, saveId === null ? board() : { ...board(), saveVersion: server.applied.get(saveId) ?? null });
  });
  t.after(() => store.getState().reset());
  return server;
}

async function until(condition) {
  for (let i = 0; i < 200 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), "condition not reached");
}

function addLocalNode(id) {
  store.getState().addNode(rect(id));
}

test("a save sends the version it started from and adopts the version the server returns", async (t) => {
  useStorage(t);
  const server = fakeServer(t, graph(rect("a")));
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  assert.equal(store.getState().serverVersion, 1);
  addLocalNode("mine");
  await store.getState().flushSave();
  assert.equal(server.puts[0].baseVersion, 1);
  assert.match(server.puts[0].saveId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(store.getState().serverVersion, 2);
  assert.equal(store.getState().saveStatus, "saved");
});

test("a 409 merges the other editor's save under local edits, retries, and undo keeps their work", async (t) => {
  useStorage(t);
  const server = fakeServer(t, graph(rect("a"), rect("b")));
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  server.edit(graph(rect("a"), rect("b", { x: 30 }), rect("theirs")));
  addLocalNode("mine");

  await store.getState().flushSave();
  await until(() => store.getState().saveStatus === "saved");
  assert.deepEqual(server.puts.map((put) => put.baseVersion), [1, 2]);
  assert.deepEqual(ids(server.data), ["a", "b", "theirs", "mine"]);
  assert.equal(server.data.nodes[1].x, 30);
  assert.equal(store.getState().serverVersion, 3);

  store.getState().undo();
  const present = store.getState().history.present;
  assert.deepEqual(ids(present), ["a", "b", "theirs"]);
  assert.equal(present.nodes[1].x, 30);
});

test("polling merges other people's saves without touching unsaved local edits", async (t) => {
  useStorage(t);
  const server = fakeServer(t, graph(rect("a")));
  store.getState().reset();
  await store.getState().loadBoard("board-1");

  assert.equal(await store.getState().pollRemote(), false);
  assert.equal(server.versionReads, 1);
  assert.equal(server.boardReads, 1, "an unchanged version never fetches the graph");

  addLocalNode("mine");
  server.edit(graph(rect("a", { x: 12 }), rect("theirs")));
  assert.equal(await store.getState().pollRemote(), true);
  const state = store.getState();
  assert.deepEqual(ids(state.history.present), ["a", "theirs", "mine"]);
  assert.equal(state.history.present.nodes[0].x, 12);
  assert.equal(state.saveStatus, "dirty");
  assert.equal(state.serverVersion, 2);

  await store.getState().flushSave();
  assert.equal(server.puts.length, 1, "the merged base version saves without a conflict");
  assert.equal(server.puts[0].baseVersion, 2);
  assert.deepEqual(ids(server.data), ["a", "theirs", "mine"]);
});

test("a poll leaves the merge to a save that is already in flight", async (t) => {
  useStorage(t);
  const server = fakeServer(t, graph(rect("a")));
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  let release;
  server.holdPut = new Promise((resolve) => { release = resolve; });
  addLocalNode("mine");
  const saving = store.getState().flushSave();
  // Leaving the page mid-save keeps the draft tied to the save that is carrying it.
  store.getState().persistPendingDraft();
  assert.equal(readPendingDraft("board-1").save.id, server.puts[0].saveId);
  server.edit(graph(rect("a"), rect("theirs")));
  assert.equal(await store.getState().pollRemote(), false);
  assert.equal(store.getState().serverVersion, 1);
  release();
  await saving;
  await until(() => store.getState().saveStatus === "saved");
  assert.deepEqual(ids(server.data), ["a", "theirs", "mine"]);
});

test("a draft left by a dropped connection merges with what others saved since", async (t) => {
  useStorage(t);
  const server = fakeServer(t, graph(rect("a"), rect("theirs")));
  server.version = 3;
  savePendingDraft("board-1", graph(rect("a", { y: 5 }), rect("mine")), Date.now(), { baseVersion: 1, base: graph(rect("a")) });
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  const present = store.getState().history.present;
  assert.deepEqual(ids(present), ["a", "theirs", "mine"]);
  assert.equal(present.nodes[0].y, 5);
  assert.equal(store.getState().saveStatus, "dirty");
  await until(() => store.getState().saveStatus === "saved");
  assert.equal(server.puts[0].baseVersion, 3);
});

test("a draft too large to carry its base graph keeps the server's copy and adds only its own nodes", async (t) => {
  useStorage(t);
  const server = fakeServer(t, graph(rect("a", { x: 30 }), rect("theirs")));
  server.version = 2;
  savePendingDraft("board-1", graph(rect("a"), rect("mine")), Date.now(), { baseVersion: 1 });
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  const present = store.getState().history.present;
  assert.deepEqual(ids(present), ["a", "theirs", "mine"]);
  assert.equal(present.nodes[0].x, 30);
});

test("a draft from before versions never overrides a newer server edit and only adds its own nodes", async (t) => {
  useStorage(t);
  const server = fakeServer(t, graph(rect("a", { y: 9 }), rect("theirs")));
  server.version = 3;
  savePendingDraft("board-1", graph(rect("a", { y: 5 }), rect("mine")), 1);
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  const present = store.getState().history.present;
  assert.deepEqual(ids(present), ["a", "theirs", "mine"]);
  assert.equal(present.nodes[0].y, 9);
  await until(() => store.getState().saveStatus === "saved");
  assert.deepEqual(ids(server.data), ["a", "theirs", "mine"]);
  assert.equal(server.data.nodes[0].y, 9);
});

test("a draft whose save landed before the connection dropped is discarded, keeping a later edit by someone else", async (t) => {
  useStorage(t);
  const server = fakeServer(t, graph(rect("a")));
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  store.getState().addNode(rect("mine", { x: 5 }));
  // The save lands, but its response never arrives.
  server.dropResponse = true;
  await store.getState().flushSave();
  assert.equal(store.getState().saveStatus, "error");
  assert.equal(readPendingDraft("board-1").save.id, server.puts[0].saveId);
  server.dropResponse = false;
  // Leaving the board keeps that draft; someone else then moves the node this person added.
  store.getState().persistPendingDraft();
  store.getState().reset();
  server.edit(graph(rect("a"), rect("mine", { x: 40 })));

  await store.getState().loadBoard("board-1");
  assert.equal(store.getState().history.present.nodes[1].x, 40);
  assert.equal(store.getState().saveStatus, "idle");
  assert.equal(readPendingDraft("board-1"), null);
  assert.equal(server.puts.length, 1);
});

const filled = (fill, ...rest) => graph(rect("a", { fill }), ...rest);
const fillOf = (state) => state.nodes.find((node) => node.id === "a").fill;

function recolorA(fill) {
  store.getState().setSelection(["a"]);
  store.getState().updateSelectedStyle({ fill });
}

test("a save that landed without a response is not replayed over a later edit by someone else", async (t) => {
  useStorage(t);
  const server = fakeServer(t, filled("#ffffff"));
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  recolorA("#111111");
  server.dropResponse = true;
  await store.getState().flushSave();
  assert.equal(store.getState().saveStatus, "error");
  server.dropResponse = false;
  // Polling waits for the retry to find out whether that save landed.
  assert.equal(await store.getState().pollRemote(), false);
  server.edit(filled("#222222"));

  await store.getState().flushSave();
  await until(() => store.getState().saveStatus === "saved");
  assert.equal(fillOf(store.getState().history.present), "#222222");
  assert.equal(fillOf(server.data), "#222222");
  assert.equal(server.puts.at(-1).baseVersion, 3);
});

test("a save that never landed is retried as this person's edit", async (t) => {
  useStorage(t);
  const server = fakeServer(t, filled("#ffffff"));
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  recolorA("#111111");
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("Failed to fetch"); }, { times: 1 });
  await store.getState().flushSave();
  assert.equal(store.getState().saveStatus, "error");
  server.edit(filled("#ffffff", rect("theirs")));
  await store.getState().flushSave();
  await until(() => store.getState().saveStatus === "saved");
  assert.equal(fillOf(server.data), "#111111");
  assert.deepEqual(ids(server.data), ["a", "theirs"]);
});

test("a draft written while a save was in flight uses that save as its base once it landed", async (t) => {
  useStorage(t);
  const server = fakeServer(t, filled("#ffffff"));
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  recolorA("#111111");
  let release;
  server.holdPut = new Promise((resolve) => { release = resolve; });
  const saving = store.getState().flushSave();
  addLocalNode("later");
  // The page goes away mid-save: the draft holds the newer edits and the save in flight.
  store.getState().persistPendingDraft();
  server.dropResponse = true;
  server.holdPut = null;
  release();
  await saving;
  store.getState().reset();
  server.dropResponse = false;
  server.edit(filled("#222222"));

  await store.getState().loadBoard("board-1");
  const present = store.getState().history.present;
  assert.equal(fillOf(present), "#222222");
  assert.deepEqual(ids(present), ["a", "later"]);
  await until(() => store.getState().saveStatus === "saved");
  assert.equal(fillOf(server.data), "#222222");
  assert.deepEqual(ids(server.data), ["a", "later"]);
});

test("after many saves on a busy board a landed draft is dropped and an unlanded one still merges", async (t) => {
  useStorage(t);
  const server = fakeServer(t, filled("#ffffff"));
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  recolorA("#111111");
  server.dropResponse = true;
  await store.getState().flushSave();
  server.dropResponse = false;
  store.getState().reset();
  for (let i = 0; i < 80; i += 1) server.edit(filled(`#0000${String(i).padStart(2, "0")}`));
  await store.getState().loadBoard("board-1");
  assert.equal(fillOf(store.getState().history.present), "#000079");
  assert.equal(store.getState().saveStatus, "idle");
  assert.equal(readPendingDraft("board-1"), null);

  savePendingDraft("board-1", filled("#333333"), Date.now(), { baseVersion: 82, base: filled("#000079"), save: { id: crypto.randomUUID(), data: filled("#333333") } });
  const others = [];
  for (let i = 0; i < 80; i += 1) {
    others.push(rect(`n${i}`));
    server.edit(filled("#000079", ...others));
  }
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  const present = store.getState().history.present;
  assert.equal(fillOf(present), "#333333");
  assert.equal(present.nodes.length, 81);
});

test("a draft older than the save-id retention never asks about its save and lets the server copy win", async (t) => {
  useStorage(t);
  const server = fakeServer(t, filled("#222222", rect("theirs")));
  server.version = 4;
  const at = Date.now() - DRAFT_SYNC_MAX_AGE_MS - 1000;
  savePendingDraft("board-1", filled("#111111", rect("mine")), at, { baseVersion: 1, base: filled("#ffffff"), save: { id: crypto.randomUUID(), data: filled("#111111") } });
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  assert.equal(server.boardUrls.some((url) => url.includes("saveId")), false);
  const present = store.getState().history.present;
  assert.equal(fillOf(present), "#222222");
  assert.deepEqual(ids(present), ["a", "theirs", "mine"]);
});

test("a draft written while a save is in flight follows an undo back to the sent graph", async (t) => {
  useStorage(t);
  const server = fakeServer(t, graph(rect("a")));
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  addLocalNode("sent");
  let release;
  server.holdPut = new Promise((resolve) => { release = resolve; });
  const saving = store.getState().flushSave();
  addLocalNode("undone");
  store.getState().persistPendingDraft();
  store.getState().undo();
  store.getState().persistPendingDraft();
  const draft = readPendingDraft("board-1");
  assert.deepEqual(ids(draft.data), ["a", "sent"]);
  assert.deepEqual(draft.save, { id: server.puts[0].saveId });
  release();
  await saving;
});

const sticky = (id, text) => ({ ...rect(id), type: "sticky", text, fontSize: 16, color: "#000000" });

function startEditing(id) {
  store.getState().setSelection([id]);
  store.getState().setEditingTextId(id);
}

test("other people's saves wait while a text edit is open and merge as soon as it ends", async (t) => {
  useStorage(t);
  const server = fakeServer(t, graph(rect("a"), sticky("s", "old")));
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  startEditing("s");
  server.edit(graph(rect("a", { x: 40 }), sticky("s", "old")));
  assert.equal(await store.getState().pollRemote(), false);
  assert.equal(store.getState().history.present.nodes[0].x, 0);
  // A save during the edit (a pan) that conflicts waits too, instead of merging.
  store.getState().setViewport({ x: 10, y: 10, zoom: 1 });
  await store.getState().flushSave();
  assert.equal(store.getState().saveStatus, "dirty");
  assert.equal(store.getState().serverVersion, 1);
  assert.equal(store.getState().history.present.nodes[0].x, 0);

  store.getState().commitText("s", "old", "old");
  await until(() => store.getState().saveStatus === "saved");
  assert.equal(store.getState().history.present.nodes[0].x, 40);
  assert.equal(server.data.nodes[0].x, 40);
  assert.deepEqual(server.data.viewport, { x: 10, y: 10, zoom: 1 });
});

test("a node someone deleted during an edit without typing follows the delete, and undo never brings it back", async (t) => {
  useStorage(t);
  const server = fakeServer(t, graph(rect("a"), sticky("s", "old")));
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  addLocalNode("mine");
  await store.getState().flushSave();
  startEditing("s");
  server.edit(graph(rect("a"), rect("mine")));
  assert.equal(await store.getState().pollRemote(), false);
  assert.deepEqual(ids(store.getState().history.present), ["a", "s", "mine"], "kept on screen while being edited");

  store.getState().commitText("s", "old", "old");
  await until(() => !store.getState().history.present.nodes.some((node) => node.id === "s"));
  store.getState().undo();
  assert.deepEqual(ids(store.getState().history.present), ["a"]);
  await store.getState().flushSave();
  await until(() => store.getState().saveStatus === "saved");
  assert.deepEqual(ids(server.data), ["a"]);
  store.getState().redo();
  assert.deepEqual(ids(store.getState().history.present), ["a", "mine"]);
});

test("text typed into a node someone deleted during the edit is kept", async (t) => {
  useStorage(t);
  const server = fakeServer(t, graph(rect("a"), sticky("s", "old")));
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  startEditing("s");
  server.edit(graph(rect("a")));
  assert.equal(await store.getState().pollRemote(), false);
  store.getState().commitText("s", "typed", "old");
  await until(() => store.getState().saveStatus === "saved");
  assert.deepEqual(ids(server.data), ["a", "s"]);
  assert.equal(server.data.nodes[1].text, "typed");
  // Undoing the typing leaves the other person's delete in place.
  store.getState().undo();
  assert.deepEqual(ids(store.getState().history.present), ["a"]);
});

test("a reorder someone made during an edit is kept after it ends", async (t) => {
  useStorage(t);
  const server = fakeServer(t, graph(rect("a"), sticky("s", "old"), rect("x"), rect("b")));
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  startEditing("s");
  server.edit(graph(rect("a"), sticky("s", "old"), rect("b"), rect("x")));
  assert.equal(await store.getState().pollRemote(), false);
  store.getState().commitText("s", "old", "old");
  await until(() => store.getState().serverVersion === 2);
  assert.deepEqual(ids(store.getState().history.present), ["a", "s", "b", "x"]);
  store.getState().setViewport({ x: 10, y: 10, zoom: 1 });
  await store.getState().flushSave();
  assert.deepEqual(ids(server.data), ["a", "s", "b", "x"]);
});

const image = (id, extra = {}) => ({ id, type: "image", x: 0, y: 0, w: 10, h: 10, parentId: null, groupId: null, src: "/api/media/canvas/c.png", aspectLocked: true, ...extra });

function startCrop(id) {
  store.getState().setSelection([id]);
  store.getState().beginCrop(id);
}

const nodeById = (graphState, id) => graphState.nodes.find((item) => item.id === id);

test("during a crop other people's edits appear and are adopted, and only the cropped image waits", async (t) => {
  useStorage(t);
  const server = fakeServer(t, graph(image("c"), rect("a")));
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  startCrop("c");
  server.edit(graph(image("c"), rect("a", { x: 40 })));
  assert.equal(await store.getState().pollRemote(), true);
  assert.equal(nodeById(store.getState().history.present, "a").x, 40);
  assert.equal(store.getState().serverVersion, 2);
  // Their move of the image waits; their next two moves of a both arrive, the later one kept.
  server.edit(graph(image("c", { x: 30 }), rect("a", { x: 50 })));
  assert.equal(await store.getState().pollRemote(), true);
  server.edit(graph(image("c", { x: 30 }), rect("a", { x: 100 })));
  assert.equal(await store.getState().pollRemote(), true);
  assert.equal(store.getState().serverVersion, 4);
  assert.equal(nodeById(store.getState().history.present, "c").x, 0, "the cropped image does not move under the person");
  assert.equal(nodeById(store.getState().history.present, "a").x, 100);

  // A save during the crop goes out and keeps their move of the image.
  addLocalNode("mine");
  await store.getState().flushSave();
  assert.equal(store.getState().saveStatus, "saved");
  assert.equal(nodeById(server.data, "c").x, 30);
  assert.equal(nodeById(server.data, "a").x, 100);
  assert.deepEqual(ids(server.data), ["c", "a", "mine"]);

  // Cancelling the crop reconciles the image to their version, with nothing left to save.
  store.getState().cancelCrop();
  assert.equal(nodeById(store.getState().history.present, "c").x, 30);
  await store.getState().flushSave();
  assert.equal(nodeById(server.data, "c").x, 30);
  assert.equal(nodeById(server.data, "a").x, 100);
});

test("a crop applied while someone changed the image reconciles through the normal merge", async (t) => {
  useStorage(t);
  const server = fakeServer(t, graph(image("c"), rect("a")));
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  startCrop("c");
  server.edit(graph(image("c", { x: 30 }), rect("a")));
  assert.equal(await store.getState().pollRemote(), true);
  store.getState().updateCropDraft({ zoom: 2 });
  store.getState().applyCrop();
  await store.getState().flushSave();
  await until(() => store.getState().saveStatus === "saved");
  // Both changed the image: this person's applied crop is the local edit that wins.
  assert.equal(nodeById(server.data, "c").crop.zoom, 2);
  assert.equal(store.getState().croppingImageId, null);
});

test("deleting the image being cropped ends the crop and sync carries on", async (t) => {
  useStorage(t);
  const server = fakeServer(t, graph(image("c"), rect("a")));
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  store.getState().setSelection(["c"]);
  store.getState().beginCrop("c");
  store.getState().deleteSelected();
  assert.equal(store.getState().croppingImageId, null);
  server.edit(graph(image("c"), rect("a", { x: 40 })));
  assert.equal(await store.getState().pollRemote(), true);
  assert.equal(nodeById(store.getState().history.present, "a").x, 40);
  addLocalNode("mine");
  await store.getState().flushSave();
  await until(() => store.getState().saveStatus === "saved");
  assert.deepEqual(ids(server.data), ["a", "mine"]);
  assert.equal(server.data.nodes[0].x, 40);
});

test("a draft on the server's current version keeps its deletions without carrying its base graph", async (t) => {
  useStorage(t);
  const server = fakeServer(t, graph(rect("a"), rect("b")));
  server.version = 2;
  savePendingDraft("board-1", graph(rect("a")), Date.now(), { baseVersion: 2 });
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  assert.deepEqual(ids(store.getState().history.present), ["a"]);
  await until(() => store.getState().saveStatus === "saved");
  assert.deepEqual(ids(server.data), ["a"]);
});

test("ending an inline edit without typing keeps another person's newer text", async (t) => {
  useStorage(t);
  const sticky = (text) => ({ ...rect("note"), type: "sticky", text, fontSize: 16, color: "#000000" });
  const server = fakeServer(t, graph(sticky("old")));
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  store.getState().setSelection(["note"]);
  store.getState().setEditingTextId("note");
  server.edit(graph(sticky("new")));
  // The editor blurs with the text it started from.
  store.getState().commitText("note", "old", "old");
  await until(() => store.getState().history.present.nodes[0].text === "new");
  assert.equal(store.getState().editingTextId, null);
  assert.equal(store.getState().saveStatus, "idle");
  await store.getState().flushSave();
  assert.deepEqual(server.puts, []);
});

test("an inline text edit commits to its node even after the selection moved on", (t) => {
  t.after(() => store.getState().reset());
  store.getState().reset();
  store.getState().addNode({ ...rect("note"), type: "sticky", text: "", fontSize: 16, color: "#000000" });
  store.getState().setEditingTextId("note");
  const before = store.getState().history.past.length;
  // A click on empty canvas clears the selection (and the editing id) before the editor blurs.
  store.getState().clearSelection();
  store.getState().commitText("note", "typed", "");
  assert.equal(store.getState().history.present.nodes[0].text, "typed");
  assert.equal(store.getState().history.past.length, before + 1);
  assert.equal(store.getState().saveStatus, "dirty");
  store.getState().commitText("note", "typed", "");
  assert.equal(store.getState().history.past.length, before + 1, "an unchanged commit adds no undo step");
});
