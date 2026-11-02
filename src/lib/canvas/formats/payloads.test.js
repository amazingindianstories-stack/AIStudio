import test from "node:test";
import assert from "node:assert/strict";
import { createPayloadLoader, needsPayload, payloadsToLoad, withPayload } from "./payloads.js";
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

test("the loader asks once per node and revision and retries after a failure", async () => {
  let calls = 0;
  let fail = true;
  const loader = createPayloadLoader(async (id) => {
    calls += 1;
    if (fail) throw new Error("offline");
    return { kind: "doc", rev: 2, size: 1, blocks: [], id };
  });
  await assert.rejects(loader.load(doc), /offline/);
  fail = false;
  const [a, b] = await Promise.all([loader.load(doc), loader.load(doc)]);
  assert.equal(a, b);
  await loader.load(doc);
  assert.equal(calls, 2);
  await loader.load({ ...doc, payload: { size: 10, rev: 3 } });
  assert.equal(calls, 3);
  loader.forget("d");
  await loader.load(doc);
  assert.equal(calls, 4);
  assert.equal(await loader.load({ id: "z" }), null);
});

test("only visible nodes that need a payload load, up to the limit", () => {
  const nodes = [doc, { ...doc, id: "e" }, { ...doc, id: "f", blocks: [] }, { ...doc, id: "g" }];
  assert.deepEqual(payloadsToLoad(nodes, (n) => n.id !== "e"), ["d", "g"]);
  assert.deepEqual(payloadsToLoad(nodes, () => true, 1), ["d"]);
});
