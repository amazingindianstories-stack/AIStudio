import test from "node:test";
import assert from "node:assert/strict";
import { carryPayloads, createPayloadLoader, needsPayload, slimGraph, slimLength, withLoadedPayload, withPayload } from "./payloads.js";
import { validateCanvasState } from "../serialization.js";

const ref = { size: 10, rev: 2 };
const doc = { id: "d", type: "format", format: "doc", x: 0, y: 0, w: 9, h: 9, payload: ref };

test("a node holding a reference without its fields needs its payload", () => {
  assert.equal(needsPayload(doc), true);
  assert.equal(needsPayload({ ...doc, blocks: [] }), false);
  assert.equal(needsPayload({ ...doc, payload: undefined }), false);
  assert.equal(needsPayload({ id: "r", type: "rect" }), false);
  assert.equal(needsPayload({ ...doc, format: "deck" }), false);
});

test("validation keeps the reference and invents no empty fields for an unloaded node", () => {
  const node = validateCanvasState({ nodes: [{ ...doc, payload: { size: 10, rev: 2 } }] }).nodes[0];
  assert.deepEqual(node.payload, ref);
  assert.equal("blocks" in node, false);
  const html = validateCanvasState({ nodes: [{ id: "h", type: "format", format: "html", x: 0, y: 0, w: 9, h: 9, payload: ref }] }).nodes[0];
  assert.equal("html" in html, false);
  const inline = validateCanvasState({ nodes: [{ id: "h", type: "format", format: "html", x: 0, y: 0, w: 9, h: 9 }] }).nodes[0];
  assert.equal(inline.html, "");
  assert.equal("payload" in inline, false);
});

test("a malformed reference is ignored", () => {
  const node = validateCanvasState({ nodes: [{ ...doc, payload: { size: -1, rev: "x" } }] }).nodes[0];
  assert.equal("payload" in node, false);
  assert.deepEqual(node.blocks.length >= 0, true);
});

test("a loaded payload fills its node in the validated shape", () => {
  const loaded = withPayload(doc, { kind: "doc", rev: 2, size: 10, blocks: [{ id: "b", type: "p", text: "hi" }], suggestions: [] });
  assert.equal(loaded.blocks[0].text, "hi");
  assert.equal("suggestions" in loaded, false);
  assert.equal(needsPayload(loaded), false);
  const drawio = withPayload({ id: "x", type: "format", format: "drawio", payload: ref }, { kind: "drawio", rev: 3, size: 5, xml: "<m/>", preview: "" });
  assert.deepEqual([drawio.xml, "preview" in drawio, drawio.payload.rev], ["<m/>", false, 3]);
  assert.equal(withPayload(doc, { kind: "html", html: "x" }), doc);
});

test("the loader asks once at a time per board, node and revision and retries after a failure", async () => {
  let calls = 0;
  let fail = true;
  const asked = [];
  const loader = createPayloadLoader(async (boardId, id) => {
    calls += 1;
    asked.push(`${boardId}/${id}`);
    if (fail) throw new Error("offline");
    return { kind: "doc", rev: 2, size: 1, blocks: [], id };
  });
  await assert.rejects(loader.load("b1", doc), /offline/);
  fail = false;
  const [a, b] = await Promise.all([loader.load("b1", doc), loader.load("b1", doc)]);
  assert.equal(a, b);
  assert.equal(calls, 2);
  await Promise.all([loader.load("b1", { ...doc, payload: { size: 10, rev: 3 } }), loader.load("b2", doc)]);
  assert.equal(calls, 4);
  assert.deepEqual(asked.slice(-2), ["b1/d", "b2/d"]);
  assert.equal(await loader.load("b1", { id: "z" }), null);
  assert.equal(await loader.load("b1", { ...doc, blocks: [] }), null);
  assert.equal(calls, 4);
});

test("a loaded payload fills only the node that still needs that revision", () => {
  const graph = { nodes: [doc, { ...doc, id: "e" }] };
  const filled = withLoadedPayload(graph, "d", { kind: "doc", rev: 2, size: 10, blocks: [{ id: "b", type: "p", text: "hi" }] });
  assert.equal(filled.nodes[0].blocks[0].text, "hi");
  assert.equal(filled.nodes[1], graph.nodes[1]);
  assert.equal(withLoadedPayload(graph, "d", { kind: "doc", rev: 3, size: 10, blocks: [] }), graph);
  assert.equal(withLoadedPayload(filled, "d", { kind: "doc", rev: 2, size: 10, blocks: [] }), filled);
});

test("a board read without payloads keeps the ones loaded at the same revision", () => {
  const loaded = { ...doc, blocks: [{ id: "b", type: "p", text: "hi" }] };
  const base = { nodes: [loaded, { ...loaded, id: "e" }] };
  const remote = { nodes: [{ ...doc, x: 5 }, { ...doc, id: "e", payload: { size: 10, rev: 3 } }] };
  const carried = carryPayloads(remote, base);
  assert.deepEqual([carried.nodes[0].x, carried.nodes[0].blocks[0].text], [5, "hi"]);
  assert.equal(carried.nodes[1], remote.nodes[1]);
  assert.equal(carryPayloads(remote, { nodes: [doc] }), remote);
});

test("a save or draft keeps a payload only where it differs from the synced graph", () => {
  const one = [{ id: "b", type: "p", text: "one" }];
  const base = { nodes: [{ ...doc, blocks: one }, { ...doc, id: "e", blocks: one }, { ...doc, id: "u" }, { id: "n", type: "format", format: "html", html: "<p/>" }] };
  const sent = { nodes: [{ ...doc, blocks: [...one] }, { ...doc, id: "e", blocks: [{ id: "b", type: "p", text: "two" }] }, { ...doc, id: "u", blocks: one }, base.nodes[3], { ...doc, id: "new", payload: undefined, blocks: one }] };
  const slim = slimGraph(sent, base);
  assert.equal("blocks" in slim.nodes[0], false);
  assert.deepEqual(slim.nodes[0].payload, ref);
  assert.equal(slim.nodes[1].blocks[0].text, "two");
  assert.equal(slim.nodes[2].blocks[0].text, "one");
  assert.equal(slim.nodes[3].html, "<p/>");
  assert.equal(slim.nodes[4].blocks[0].text, "one");
  assert.equal(slimGraph({ nodes: [doc] }, base).nodes[0], doc);
});

test("the board limit is measured without payload fields", () => {
  const big = { nodes: [{ ...doc, blocks: [{ id: "b", type: "p", text: "x".repeat(5000) }] }, { id: "r", type: "rect" }] };
  assert.ok(slimLength(big) < 500);
  assert.equal(slimLength({ nodes: [doc] }), JSON.stringify({ nodes: [doc] }).length);
});
