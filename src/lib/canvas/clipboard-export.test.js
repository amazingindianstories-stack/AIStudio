import assert from "node:assert/strict";
import test from "node:test";
import { expandSelection, selectionSvg, selectionText, wrapLines } from "./clipboard-export.js";

const node = (id, type, x, y, extra = {}) => ({ id, type, x, y, w: 100, h: 100, parentId: null, groupId: null, ...extra });

const board = {
  nodes: [
    node("frame", "frame", 0, 0, { name: "Plan", w: 400, h: 300 }),
    node("second", "sticky", 200, 20, { text: "Second", parentId: "frame", fill: "#fde68a" }),
    node("first", "sticky", 20, 20, { text: "First", parentId: "frame", fill: "#fde68a" }),
    node("loose", "text", 600, 0, { text: "Loose <note>" }),
    node("img", "image", 600, 400, { alt: "A cat", src: "/api/media/cat.png" }),
    node("blank", "rect", 900, 0, { text: "  " }),
  ],
  connectors: [
    { id: "c1", from: { nodeId: "first" }, to: { nodeId: "second" }, kind: "arrow", stroke: "#fff", strokeWidth: 2 },
    { id: "c2", from: { nodeId: "first" }, to: { nodeId: "loose" }, kind: "line", stroke: "#fff", strokeWidth: 2 },
  ],
};

test("a selected frame brings its contents along", () => {
  assert.deepEqual(expandSelection(board, ["frame"]).map((n) => n.id).sort(), ["first", "frame", "second"]);
  assert.deepEqual(expandSelection(board, ["loose"]).map((n) => n.id), ["loose"]);
});

test("copied text is each object's text in reading order, a frame's title before its contents", () => {
  assert.equal(selectionText(board, ["loose", "frame"]), "Plan\nFirst\nSecond\nLoose <note>");
  // A child selected along with its frame is written once, under the frame.
  assert.equal(selectionText(board, ["second", "frame"]), "Plan\nFirst\nSecond");
  assert.equal(selectionText(board, ["img", "blank"]), "A cat");
  assert.equal(selectionText(board, []), "");
});

test("wraps words to the width, keeping explicit line breaks", () => {
  const measure = (s) => s.length * 10;
  assert.deepEqual(wrapLines("one two three", 70, measure), ["one two", "three"]);
  assert.deepEqual(wrapLines("a\nb", 100, measure), ["a", "b"]);
  assert.deepEqual(wrapLines("averyveryverylongword", 50, measure), ["averyveryverylongword"]);
});

test("the image is drawn from board data with escaped text, connectors inside the selection and placeholders for unread images", () => {
  const measure = (s, size) => s.length * size * 0.5;
  const drawn = selectionSvg(board, ["frame", "loose", "img"], { measure, images: new Map() });
  assert.ok(drawn.width > 0 && drawn.height > 0);
  assert.match(drawn.svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.match(drawn.svg, /Loose &lt;note&gt;/);
  assert.match(drawn.svg, />Plan</);
  assert.match(drawn.svg, /marker-end="url\(#arrow-c1\)"/);
  // Both ends of c2 are selected too (first via its frame, loose directly).
  assert.equal((drawn.svg.match(/<path d="[^"]*" fill="none"/g) ?? []).length, 2);
  assert.doesNotMatch(drawn.svg, /<image /);

  const withImage = selectionSvg(board, ["img"], { measure, images: new Map([["img", "data:image/png;base64,AA=="]]) });
  assert.match(withImage.svg, /<image href="data:image\/png;base64,AA=="/);
  assert.equal(selectionSvg(board, [], { measure }), null);
});

test("shape text without its own color is drawn in the light color the board shows", () => {
  const measure = (s, size) => s.length * size * 0.5;
  const shapes = {
    nodes: [
      node("plain", "rect", 0, 0, { text: "Default", fill: "rgba(255,255,255,0.06)", stroke: "#fff", strokeWidth: 2 }),
      node("colored", "ellipse", 200, 0, { text: "Colored", color: "#ff0000", fill: "#000", stroke: "#fff", strokeWidth: 2 }),
    ],
    connectors: [],
  };
  const fills = (svg) => [...svg.matchAll(/<text [^>]*fill="([^"]+)"[^>]*>/g)].map((m) => m[1]);
  assert.deepEqual(fills(selectionSvg(shapes, ["plain", "colored"], { measure, images: new Map() }).svg), ["#ffffff", "#ff0000"]);
});

const diagramBoard = {
  nodes: [
    node("lane", "swimlane", 0, 0, { name: "Flow & co", w: 600, h: 334, lanes: [{ id: "a", name: "Buyer", size: 150 }, { id: "b", name: "Seller", size: 150 }], stroke: "#52525b" }),
    node("ask", "sticky", 200, 60, { text: "Ask", parentId: "lane", fill: "#fde68a" }),
    node("erd", "erd", 700, 0, { name: "users", columns: 2, w: 240, h: 120, rows: [{ id: "r", cells: ["email", "text", "hidden"] }] }),
    node("dia", "diagram", 0, 500, { name: "System", w: 400, h: 300 }),
    node("server", "shape", 700, 500, { shape: "custom", svg: "<rect width='10' height='10'/>", svgViewBox: "0 0 10 10", fill: "#fff", stroke: "#000", strokeWidth: 1 }),
    node("tip", "sticky", 1100, 800, { text: "", fill: "#fde68a" }),
    node("bubble", "shape", 1000, 500, { shape: "callout", tail: { nodeId: "tip", anchor: "auto" }, fill: "#fff", stroke: "#000", strokeWidth: 1 }),
  ],
  connectors: [
    { id: "rel", from: { nodeId: "erd" }, to: { nodeId: "server" }, kind: "line", stroke: "#fff", strokeWidth: 2, labels: [{ id: "l", text: "hosts", position: 0.5 }] },
  ],
};

test("copied text includes diagram objects' text, a swimlane's contents under it", () => {
  assert.equal(selectionText(diagramBoard, ["erd", "lane"]), "Flow & co\nBuyer\nSeller\nAsk\nusers\nemail\ntext");
  assert.equal(selectionText(diagramBoard, ["dia"]), "System");
});

test("the image draws ERD tables, swimlanes, diagrams, custom shapes, callout tails and connector labels", () => {
  const measure = (s, size) => s.length * size * 0.5;
  const { svg } = selectionSvg(diagramBoard, ["lane", "erd", "dia", "server", "bubble"], { measure, images: new Map() });
  const texts = [...svg.matchAll(/>([^<]+)<\/t(?:ext|span)>/g)].map((m) => m[1]);
  for (const text of ["Flow &amp; co", "Buyer", "Seller", "Ask", "users", "email", "text", "DIAGRAM", "System", "hosts"]) {
    assert.ok(texts.includes(text), `missing ${text} in ${texts.join(", ")}`);
  }
  assert.ok(!texts.includes("hidden"));
  // The custom shape draws its own markup, not just a box.
  assert.match(svg, /<image href="data:image\/svg\+xml,[^"]*%3Crect%20width%3D&#39;10&#39;/);
  // The callout's tail points at the note it is attached to, where the board points it (1150, 800).
  const bubble = /<path transform="translate\(1000 500\)" d="([^"]+)"/.exec(svg)[1];
  assert.match(bubble, /L150 300 Z$/);
});

test("the image is big enough for callout tails and connector labels past the selected objects", () => {
  const measure = (s, size) => s.length * size * 0.5;
  const tailed = {
    nodes: [
      node("bubble", "shape", 0, 0, { shape: "callout", tail: { nodeId: "far", anchor: "auto" }, fill: "#fff", stroke: "#000", strokeWidth: 1 }),
      node("far", "sticky", 0, 300, { text: "", fill: "#fde68a" }),
    ],
    connectors: [],
  };
  // The tail ends on the top of the note 300 below; the image keeps its padding below that.
  const alone = selectionSvg(tailed, ["bubble"], { measure, images: new Map() });
  assert.equal(alone.height, 24 + 300 + 24);
  const linked = {
    nodes: [node("a", "sticky", 0, 0, { fill: "#fde68a" }), node("b", "sticky", 0, 400, { fill: "#fde68a" })],
    connectors: [{ id: "c", from: { nodeId: "a", anchor: "bottom" }, to: { nodeId: "b", anchor: "top" }, kind: "line", shape: "straight", stroke: "#fff", strokeWidth: 2, labels: [{ id: "l", text: "a long label that is wider than the note", position: 0.5 }] }],
  };
  // Only the connector is selected with "a": its line and label reach below "a" and out past its sides.
  const { svg, width, height } = selectionSvg(linked, ["a"], { measure, images: new Map(), selectedConnectorIds: ["c"] });
  assert.match(svg, />a long label that is wider than the note</);
  const labelWidth = Math.max(36, "a long label that is wider than the note".length * 6.8 + 14);
  assert.ok(width >= labelWidth + 48, `width ${width}`);
  assert.ok(height >= 400 + 48, `height ${height}`);
});

test("a callout whose tail points at an object that is not drawn is drawn without the tail", () => {
  const board = { nodes: [node("bubble", "shape", 500, 500, { shape: "callout", tail: { nodeId: "hidden", anchor: "auto" }, fill: "#fff", stroke: "#000", strokeWidth: 1 })], connectors: [] };
  const { width, height } = selectionSvg(board, ["bubble"], { measure: () => 0, images: new Map() });
  assert.deepEqual([width, height], [148, 148]);
});

test("a rotated object is drawn turned about its center, wrapped at its own width, inside a box that fits the turn", () => {
  const measure = (s, size) => s.length * size * 0.5;
  const turned = { nodes: [node("tall", "sticky", 0, 0, { w: 200, h: 100, rotation: 90, text: "one two three four five six", fill: "#fde68a" })], connectors: [] };
  const flat = { nodes: [{ ...turned.nodes[0], rotation: 0 }], connectors: [] };
  const drawn = selectionSvg(turned, ["tall"], { measure, images: new Map() });
  const plain = selectionSvg(flat, ["tall"], { measure, images: new Map() });
  assert.match(drawn.svg, /<g transform="rotate\(90 100 50\)">/);
  assert.doesNotMatch(plain.svg, /rotate\(/);
  const lines = (svg) => (svg.match(/<tspan /g) ?? []).length;
  assert.equal(lines(drawn.svg), lines(plain.svg));
  assert.deepEqual([drawn.width, drawn.height], [plain.height, plain.width]);
});
