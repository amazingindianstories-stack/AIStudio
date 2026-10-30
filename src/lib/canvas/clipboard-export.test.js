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
