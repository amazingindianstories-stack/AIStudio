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

test("exportScope maps a lone selected frame to a frame export", async () => {
  const { exportScope, exportFileName } = await import("./board-export-run.js");
  const state = { nodes: [{ id: "f", type: "frame" }, { id: "s", type: "sticky" }] };
  assert.deepEqual(exportScope(state, ["f"], "selection"), { frameId: "f" });
  assert.deepEqual(exportScope(state, ["s", "f"], "selection"), { nodeIds: ["s", "f"] });
  assert.deepEqual(exportScope(state, ["s"], "board"), {});
  assert.deepEqual(exportScope(state, [], "selection"), {});
  assert.equal(exportFileName("My / Board!", "jpg"), "My-Board.jpg");
  assert.equal(exportFileName("", "svg", "p1"), "board-p1.svg");
});

test("downloadable images are the selected image nodes with a source", async () => {
  const { downloadableImages, originalFileName } = await import("./board-export-run.js");
  const state = { nodes: [
    { id: "a", type: "image", src: "/api/media/a" },
    { id: "b", type: "image" },
    { id: "c", type: "sticky" },
  ] };
  assert.deepEqual(downloadableImages(state, ["a", "b", "c"]).map((n) => n.id), ["a"]);
  assert.deepEqual(downloadableImages(state, []), []);
  assert.equal(originalFileName({ name: "Logo v2" }, "image/png", 0), "Logo v2.png");
  assert.equal(originalFileName({ name: "shot.jpeg" }, "image/jpeg", 0), "shot.jpeg");
  assert.equal(originalFileName({}, "image/webp", 2), "image-3.webp");
});

test("pdf export is a well-formed vector file with escaped text, arrowheads and rotation", async () => {
  const { boardPdf, parseColor, svgPathToPdf } = await import("./board-export-pdf.js");
  const pdf = boardPdf({
    nodes: [
      ...state.nodes.map((n) => (n.id === "a" ? { ...n, text: "Hi (there) \\ 中", rotation: 15 } : n)),
      { id: "e", type: "ellipse", x: 0, y: 400, w: 80, h: 60, fill: "#00f", stroke: "red", ...base },
    ],
    connectors: state.connectors,
  });
  const text = Buffer.from(pdf).toString("latin1");
  assert.match(text, /^%PDF-1\.4/);
  assert.ok(text.includes("Hi \\(there\\) \\\\ ?"));
  assert.ok(text.includes("MediaBox"));
  assert.ok(!text.includes("javascript"));
  const declared = Number(/\/Length (\d+)/.exec(text)[1]);
  const body = text.slice(text.indexOf("stream\n") + 7, text.indexOf("endstream"));
  assert.equal(body.length, declared);
  const startxref = Number(/startxref\n(\d+)/.exec(text)[1]);
  assert.ok(text.slice(startxref).startsWith("xref"));
  assert.equal(boardPdf({ nodes: [] }), null);
  assert.equal(parseColor("url(x)"), null);
  assert.deepEqual(parseColor("#fff"), [1, 1, 1]);
  assert.equal(parseColor("rgba(0,0,0,0)"), null);
  assert.match(svgPathToPdf("M 0 0 Q 5 5 10 0 L 20 0 Z").ops, / c\n.* l\nh$/);
});
