import test from "node:test";
import assert from "node:assert/strict";
import { boardSvg, exportNodes } from "./board-export-svg";
import { boardTextCsv } from "./board-export-csv";

const base = { parentId: null, groupId: null };
const state = {
  nodes: [
    { id: "f", type: "frame", name: "Frame <1>", x: 0, y: 0, w: 400, h: 300, fill: "transparent", stroke: "#000", ...base },
    { id: "a", type: "sticky", x: 10, y: 10, w: 200, h: 100, fill: "#fff59d", text: "Hello & bye", ...base, parentId: "f" },
    { id: "b", type: "rect", x: 500, y: 500, w: 50, h: 50, fill: "url(javascript:x)", stroke: "#000", text: "=cmd", ...base },
  ],
  connectors: [{ id: "c", from: { nodeId: "a", anchor: "auto" }, to: { nodeId: "b", anchor: "auto" }, stroke: "#000", strokeWidth: 2, kind: "arrow" }],
};

test("svg covers the whole board including far-off nodes and escapes text", () => {
  const svg = boardSvg(state);
  assert.match(svg, /^<\?xml/);
  assert.ok(svg.includes("Hello &amp; bye"));
  assert.ok(svg.includes("Frame &lt;1&gt;"));
  assert.ok(!svg.includes("javascript"));
  assert.ok(svg.includes("marker-end"));
  assert.match(svg, /viewBox="-24 -24 /);
});

test("frame export holds only its members and drops connectors to outside nodes", () => {
  assert.deepEqual(exportNodes(state, { frameId: "f" }).map((n) => n.id), ["f", "a"]);
  const svg = boardSvg(state, { frameId: "f" });
  assert.ok(!svg.includes("marker-end="));
  assert.ok(!svg.includes("=cmd"));
});

test("empty selection exports nothing", () => {
  assert.equal(boardSvg(state, { nodeIds: [] }), null);
});

test("text csv neutralizes formulas and covers frames", () => {
  const csv = boardTextCsv(state);
  assert.ok(csv.includes("sticky,Hello & bye"));
  assert.ok(csv.includes("rect,'=cmd"));
  assert.ok(csv.includes("frame,Frame <1>"));
  assert.equal(boardTextCsv({ nodes: [] }), null);
});
