import test from "node:test";
import assert from "node:assert/strict";
import { boardVisio, crc32 } from "./board-export-visio";
import { importVisio, zipEntries } from "./import-visio";

const state = {
  nodes: [
    { id: "a", type: "rect", x: 100, y: 100, w: 192, h: 96, text: "Start & go", fill: "#ff0000" },
    { id: "b", type: "ellipse", x: 500, y: 300, w: 192, h: 96, text: "End" },
  ],
  connectors: [{ id: "c", from: { nodeId: "a" }, to: { nodeId: "b" }, kind: "arrow" }],
};

test("crc32 matches the known check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("writes a valid zip and round-trips through the importer", async () => {
  const bytes = boardVisio(state);
  const names = zipEntries(bytes).map((e) => e.name);
  assert.ok(names.includes("[Content_Types].xml") && names.includes("visio/pages/page1.xml"));
  const { nodes, connectors } = await importVisio(bytes, { newId: (() => { let n = 0; return () => `i${++n}`; })() });
  assert.equal(nodes.length, 2);
  assert.deepEqual(nodes.map((n) => n.text), ["Start & go", "End"]);
  assert.equal(nodes[0].fill, "#ff0000");
  assert.equal(nodes[1].type, "ellipse");
  assert.equal(connectors.length, 1);
  assert.equal(connectors[0].from.nodeId, "i1");
  assert.equal(connectors[0].to.nodeId, "i2");
  assert.ok(Math.abs(nodes[1].x - nodes[0].x - 400) < 0.1 && Math.abs(nodes[1].y - nodes[0].y - 200) < 0.1);
});

test("returns null for an empty selection and escapes text", () => {
  assert.equal(boardVisio({ nodes: [], connectors: [] }), null);
  const xml = Buffer.from(boardVisio({ nodes: [{ id: "x", type: "rect", x: 0, y: 0, w: 10, h: 10, text: "<b>a</b> <script>" }] })).toString("latin1");
  assert.ok(!xml.includes("<script>"));
});
