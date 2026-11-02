import assert from "node:assert/strict";
import test from "node:test";
import { useCanvasStore } from "./canvas-store.js";
import { readPendingDraft } from "./canvas-pending-draft.js";
import { emptyCanvasState } from "./canvas/serialization.js";
import { applyBoardPatch } from "./canvas/patch.js";

const store = useCanvasStore;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const unloaded = (id, rev = 1) => ({ id, type: "format", format: "doc", name: "Doc", x: 0, y: 0, w: 90, h: 90, parentId: null, groupId: null, payload: { size: 40, rev } });
const blocks = (text) => [{ id: "b", type: "p", text }];
const node = (id) => store.getState().history.present.nodes.find((item) => item.id === id);
const withNode = (id, patch) => (present) => ({ ...present, nodes: present.nodes.map((item) => (item.id === id ? { ...item, ...patch } : item)) });

function useStorage(t) {
  const map = new Map();
  const value = { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
  Object.defineProperty(globalThis, "localStorage", { value, configurable: true, writable: true });
  t.after(() => delete globalThis.localStorage);
}

/** A board whose format payloads live in their own rows, read with `?payloads=lazy` as apps.canvas does. */
function lazyServer(t, nodes, rows) {
  const server = { version: 1, data: { ...emptyCanvasState(), nodes }, rows, urls: [], saves: [], payloadReads: 0 };
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    server.urls.push(url);
    const payload = url.match(/\/payloads\/([^/?]+)$/);
    if (payload) {
      server.payloadReads += 1;
      const row = server.rows[payload[1]];
      return row ? json(200, { nodeId: payload[1], kind: "doc", ...row }) : json(404, { error: "Payload not found." });
    }
    if (init.method === "PUT" || init.method === "PATCH") {
      const body = JSON.parse(init.body);
      const sent = init.method === "PUT" ? body.data : applyBoardPatch(server.data, body.patch);
      server.saves.push({ method: init.method, body });
      const stamps = {};
      server.data = {
        ...sent,
        nodes: sent.nodes.map((item) => {
          if (item.type !== "format" || !("blocks" in item)) return item;
          const { blocks: sentBlocks, ...slim } = item;
          const old = server.rows[item.id];
          if (old && JSON.stringify(old.blocks) === JSON.stringify(sentBlocks)) return { ...slim, payload: { size: old.size, rev: old.rev } };
          const rev = (old?.rev ?? 0) + 1;
          server.rows[item.id] = { rev, size: 50, blocks: sentBlocks };
          stamps[item.id] = { payload: { size: 50, rev } };
          return { ...slim, payload: { size: 50, rev } };
        }),
      };
      server.version += 1;
      return json(200, { ok: true, updatedAt: server.version, version: server.version, stamps });
    }
    return json(200, { id: "board-1", projectId: "p", name: "Board", role: "edit", version: server.version, data: server.data });
  });
  t.after(() => store.getState().reset());
  return server;
}

test("the editor reads payloads lazily, loads one on demand and saves it only when it changed", async (t) => {
  useStorage(t);
  const server = lazyServer(t, [unloaded("d")], { d: { rev: 1, size: 40, blocks: blocks("one") } });
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  assert.ok(server.urls[0].includes("payloads=lazy"));
  assert.equal("blocks" in node("d"), false);

  await store.getState().loadPayload("d");
  assert.equal(node("d").blocks[0].text, "one");
  assert.equal(store.getState().serverState.nodes[0].blocks[0].text, "one");
  assert.equal(store.getState().saveStatus, "idle");
  await store.getState().loadPayload("d");
  assert.equal(server.payloadReads, 1);

  store.getState().editBoard(withNode("d", { x: 40 }));
  await store.getState().flushSave();
  const moved = server.saves[0].body.patch.nodes.upsert[0];
  assert.deepEqual([moved.x, "blocks" in moved, moved.payload.rev], [40, false, 1]);
  assert.ok(server.urls.at(-1).includes("payloads=lazy"));

  store.getState().editBoard(withNode("d", { blocks: blocks("two") }));
  await store.getState().flushSave();
  assert.equal(server.saves[1].body.patch.nodes.upsert[0].blocks[0].text, "two");
  assert.equal(server.rows.d.blocks[0].text, "two");
  assert.deepEqual([node("d").payload.rev, node("d").blocks[0].text], [2, "two"]);
  assert.equal(store.getState().serverState.nodes[0].payload.rev, 2);
  assert.equal(store.getState().saveStatus, "saved");
});

test("another person's save keeps a loaded payload whose revision did not change and unloads one that did", async (t) => {
  useStorage(t);
  const server = lazyServer(t, [unloaded("d"), unloaded("e")], { d: { rev: 1, size: 40, blocks: blocks("one") }, e: { rev: 1, size: 40, blocks: blocks("old") } });
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  await Promise.all([store.getState().loadPayload("d"), store.getState().loadPayload("e")]);
  server.data = { ...server.data, nodes: [{ ...unloaded("d"), x: 70 }, unloaded("e", 2)] };
  server.rows.e = { rev: 2, size: 40, blocks: blocks("new") };
  server.version += 1;
  assert.equal(await store.getState().pollRemote(), true);
  assert.deepEqual([node("d").x, node("d").blocks[0].text], [70, "one"]);
  assert.equal("blocks" in node("e"), false);
  await store.getState().loadPayload("e");
  assert.equal(node("e").blocks[0].text, "new");
});

test("duplicating an object whose payload has not loaded loads it first and copies its content", async (t) => {
  useStorage(t);
  const server = lazyServer(t, [unloaded("d")], { d: { rev: 1, size: 40, blocks: blocks("one") } });
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  store.getState().setSelection(["d"]);
  store.getState().duplicateSelected();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const nodes = store.getState().history.present.nodes;
  assert.equal(nodes.length, 2);
  const copy = nodes.find((item) => item.id !== "d");
  assert.equal(copy.blocks[0].text, "one");
  assert.equal("payload" in copy, false);
  assert.equal(server.payloadReads, 1);
});

test("the pending draft holds a payload only where it differs from the synced board", async (t) => {
  useStorage(t);
  lazyServer(t, [unloaded("d"), unloaded("e")], { d: { rev: 1, size: 40, blocks: blocks("one") }, e: { rev: 1, size: 40, blocks: blocks("two") } });
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  await Promise.all([store.getState().loadPayload("d"), store.getState().loadPayload("e")]);
  store.getState().editBoard(withNode("e", { blocks: blocks("edited") }));
  assert.equal(store.getState().persistPendingDraft(), true);
  const draft = readPendingDraft("board-1");
  const [d, e] = draft.data.nodes;
  assert.deepEqual([d.payload.rev, "blocks" in d], [1, false]);
  assert.equal(e.blocks[0].text, "edited");
  assert.equal(draft.base.nodes.some((item) => "blocks" in item), false);
});

test("copying loads nothing, and pasting loads the copied object's payload first", async (t) => {
  useStorage(t);
  const server = lazyServer(t, [unloaded("d"), unloaded("e")], { d: { rev: 1, size: 40, blocks: blocks("one") }, e: { rev: 1, size: 40, blocks: blocks("two") } });
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  store.getState().setSelection(["d", "e"]);
  assert.equal(store.getState().copy(), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(server.payloadReads, 0);
  store.getState().paste();
  assert.equal(store.getState().history.present.nodes.length, 2);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const copies = store.getState().history.present.nodes.slice(2);
  assert.deepEqual(copies.map((item) => item.blocks[0].text), ["one", "two"]);
  assert.equal(server.payloadReads, 2);
});

test("a duplicate or paste whose payload cannot load copies nothing rather than part of the selection", async (t) => {
  useStorage(t);
  const server = lazyServer(t, [unloaded("d"), { id: "r", type: "rect", x: 0, y: 0, w: 9, h: 9, parentId: null, groupId: null }], {});
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  store.getState().setSelection(["d", "r"]);
  store.getState().duplicateSelected();
  store.getState().duplicateSelectionToward("right");
  store.getState().copy();
  store.getState().paste();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(server.payloadReads, 1);
  assert.deepEqual(store.getState().history.present.nodes.map((item) => item.id), ["d", "r"]);
  assert.deepEqual(store.getState().selection, ["d", "r"]);
});

test("an in-place duplicate waits until the selection's payloads have loaded", async (t) => {
  useStorage(t);
  lazyServer(t, [unloaded("d")], { d: { rev: 1, size: 40, blocks: blocks("one") } });
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  store.getState().setSelection(["d"]);
  assert.equal(store.getState().duplicateSelectionInPlace(), false);
  assert.equal(store.getState().history.present.nodes.length, 1);
  await store.getState().loadPayload("d");
  assert.equal(store.getState().duplicateSelectionInPlace(), true);
  assert.deepEqual(store.getState().history.present.nodes.map((item) => item.blocks[0].text), ["one", "one"]);
});

test("cutting loads the cut objects' payloads before the deleting save, so a paste after it keeps their content", async (t) => {
  useStorage(t);
  const server = lazyServer(t, [unloaded("d"), unloaded("e")], { d: { rev: 1, size: 40, blocks: blocks("one") }, e: { rev: 1, size: 40, blocks: blocks("two") } });
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  store.getState().setSelection(["d"]);
  assert.equal(store.getState().cut(), true);
  assert.ok(node("d"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(node("d"), undefined);
  assert.equal(server.payloadReads, 1);
  await store.getState().flushSave();
  assert.deepEqual(server.saves[0].body.patch.nodes.delete, ["d"]);
  delete server.rows.d;
  store.getState().paste();
  const nodes = store.getState().history.present.nodes;
  assert.deepEqual(nodes.map((item) => item.id === "e" ? "e" : item.blocks[0].text), ["e", "one"]);
});

test("a linked copy from a connection handle waits for its source's payload and carries no reference", async (t) => {
  useStorage(t);
  lazyServer(t, [unloaded("d")], { d: { rev: 1, size: 40, blocks: blocks("one") } });
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  assert.equal(store.getState().quickCreateFromNode("d"), null);
  assert.equal(store.getState().history.present.nodes.length, 1);
  await store.getState().loadPayload("d");
  const id = store.getState().quickCreateFromNode("d");
  assert.deepEqual([node(id).blocks[0].text, "payload" in node(id)], ["one", false]);
});
