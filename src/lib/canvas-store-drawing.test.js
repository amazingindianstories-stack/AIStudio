import assert from "node:assert/strict";
import test from "node:test";
import { useCanvasStore } from "./canvas-store.js";
import { emptyCanvasState, validateCanvasState } from "./canvas/serialization.js";
import { PEN_COLORS, PEN_WIDTHS } from "./canvas/ink.js";
import { commitStroke, eraseStep } from "./ink-actions.js";
import { addEmptyGrid, addGridFromText, gridOps } from "./grid-actions.js";
import { addSyncedCopy } from "./synced-actions.js";

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

async function board(t, role = "edit") {
  t.mock.method(globalThis, "fetch", async (url, init = {}) =>
    (init.method || "GET") === "PUT" ? json({ ok: true, updatedAt: Date.now() }) : json({ id: "board-1", name: "B", data: emptyCanvasState(), updatedAt: 1, role }));
  useCanvasStore.getState().reset();
  await useCanvasStore.getState().loadBoard("board-1");
  t.after(() => useCanvasStore.getState().reset());
  return useCanvasStore;
}

const nodes = (store) => store.getState().history.present.nodes;
const line = Array.from({ length: 40 }, (_, i) => ({ x: i * 10, y: 100 }));
const style = { stroke: PEN_COLORS[0], strokeWidth: PEN_WIDTHS[1], highlighter: false };

test("a pen stroke becomes one compact ink node, saved as one undo step", async (t) => {
  const store = await board(t);
  const node = commitStroke(line, style, 1);
  assert.equal(nodes(store).length, 1);
  assert.equal(node.type, "ink");
  assert.ok(node.pts.length < line.length * 2, "the stroke is simplified");
  assert.equal(store.getState().history.past.length, 1);
  const reloaded = validateCanvasState({ ...emptyCanvasState(), nodes: nodes(store) });
  assert.equal(reloaded.nodes.length, 1, "the ink survives the serializer");
});

test("the eraser removes a whole stroke it touches and leaves the others", async (t) => {
  const store = await board(t);
  commitStroke(line, style, 1);
  commitStroke(line.map((p) => ({ x: p.x, y: p.y + 500 })), style, 1);
  eraseStep({ x: 100, y: 100 }, 1, false);
  assert.equal(nodes(store).length, 1);
  assert.ok(nodes(store)[0].y > 400);
});

test("the precision eraser cuts a stroke in two instead of removing it", async (t) => {
  const store = await board(t);
  commitStroke(line, style, 1);
  eraseStep({ x: 200, y: 100 }, 1, true);
  assert.equal(nodes(store).length, 2);
});

test("viewers cannot draw", async (t) => {
  const store = await board(t, "read");
  commitStroke(line, style, 1);
  assert.equal(nodes(store).length, 0);
});

test("a grid is added empty or from pasted CSV, edited, and kept within limits", async (t) => {
  const store = await board(t);
  const grid = addEmptyGrid(2, 3);
  assert.deepEqual([grid.rows, grid.cols], [2, 3]);
  gridOps.text(grid.id, 0, 1, "hello");
  assert.deepEqual(nodes(store)[0].cells[0].slice(0, 3), [0, 1, "hello"]);
  assert.equal(addGridFromText("a,b\n1,2"), true);
  assert.equal(nodes(store).length, 2);
  assert.equal(addGridFromText(""), false);
});

test("a synced copy is a node pointing at the source frame", async (t) => {
  const store = await board(t);
  const node = addSyncedCopy("other-board", { id: "f1", name: "Scene", w: 400, h: 300 });
  assert.equal(nodes(store)[0].sourceBoardId, "other-board");
  assert.equal(node.type, "synced");
  const reloaded = validateCanvasState({ ...emptyCanvasState(), nodes: nodes(store) });
  assert.equal(reloaded.nodes[0].sourceNodeId, "f1");
});
