import assert from "node:assert/strict";
import test from "node:test";
import { useCanvasStore } from "./canvas-store.js";
import { savePendingDraft } from "./canvas-pending-draft.js";
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
  const server = { version: 1, data, puts: [], versionReads: 0, boardReads: 0, holdPut: null };
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
      if (body.baseVersion !== server.version) {
        return json(409, { error: "VERSION_CONFLICT", board: board() });
      }
      server.edit(body.data);
      return json(200, { ok: true, updatedAt: server.version, version: server.version });
    }
    server.boardReads += 1;
    return json(200, board());
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
  savePendingDraft("board-1", graph(rect("a", { y: 5 }), rect("mine")), 10, { baseVersion: 1, base: graph(rect("a")) });
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  const present = store.getState().history.present;
  assert.deepEqual(ids(present), ["a", "theirs", "mine"]);
  assert.equal(present.nodes[0].y, 5);
  assert.equal(store.getState().saveStatus, "dirty");
  await until(() => store.getState().saveStatus === "saved");
  assert.equal(server.puts[0].baseVersion, 3);
});

test("a draft too large to carry its base graph restores as a union that drops nobody's nodes", async (t) => {
  useStorage(t);
  const server = fakeServer(t, graph(rect("a"), rect("theirs")));
  server.version = 2;
  savePendingDraft("board-1", graph(rect("mine")), 10, { baseVersion: 1 });
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  assert.deepEqual(ids(store.getState().history.present), ["a", "theirs", "mine"]);
});

test("a draft from before versions merges as a union even when the server copy is newer", async (t) => {
  useStorage(t);
  const server = fakeServer(t, graph(rect("a"), rect("theirs")));
  server.version = 3;
  savePendingDraft("board-1", graph(rect("a", { y: 5 }), rect("mine")), 1);
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  const present = store.getState().history.present;
  assert.deepEqual(ids(present), ["a", "theirs", "mine"]);
  assert.equal(present.nodes[0].y, 5);
  await until(() => store.getState().saveStatus === "saved");
  assert.deepEqual(ids(server.data), ["a", "theirs", "mine"]);
});

test("a draft on the server's current version keeps its deletions without carrying its base graph", async (t) => {
  useStorage(t);
  const server = fakeServer(t, graph(rect("a"), rect("b")));
  server.version = 2;
  savePendingDraft("board-1", graph(rect("a")), 10, { baseVersion: 2 });
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
  assert.equal(await store.getState().pollRemote(), true);
  // The editor still shows the text it started from, and blurs with it.
  store.getState().commitText("note", "old", "old");
  assert.equal(store.getState().history.present.nodes[0].text, "new");
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
