import assert from "node:assert/strict";
import test from "node:test";
import { accessibilityIssues, boardSummary, contrastRatio, describeObject, parseColor } from "./a11y-check.js";

const node = (id, type, x, extra = {}) => ({ id, type, x, y: 0, w: 100, h: 100, parentId: null, groupId: null, ...extra });

test("parses hex, rgb and rgba colors", () => {
  assert.deepEqual(parseColor("#fff"), [255, 255, 255, 1]);
  assert.deepEqual(parseColor("#11223380").slice(0, 3), [17, 34, 51]);
  assert.deepEqual(parseColor("rgba(10, 20, 30, 0.5)"), [10, 20, 30, 0.5]);
  assert.equal(parseColor("transparent")?.[3] ?? 0, 0);
  assert.equal(parseColor("nonsense"), null);
});

test("contrast ratio matches the WCAG formula", () => {
  assert.equal(Math.round(contrastRatio("#000000", "#ffffff")), 21);
  assert.equal(contrastRatio("#777777", "#777777"), 1);
});

test("finds low contrast, missing image descriptions and untitled frames, in reading order", () => {
  const board = {
    nodes: [
      node("frame", "frame", 0, { name: "Frame 2", fill: "#ffffff" }),
      node("dim", "sticky", 200, { text: "hard to read", fill: "#fde68a", color: "#fbbf24" }),
      node("ok", "sticky", 400, { text: "fine", fill: "#fde68a", color: "#111111" }),
      node("img", "image", 600, { alt: "" }),
      node("described", "image", 800, { alt: "A cat" }),
      node("titled", "frame", 1000, { name: "Intro" }),
    ],
    connectors: [],
  };
  const issues = accessibilityIssues(board);
  assert.deepEqual(issues.map((i) => [i.id, i.kind]), [
    ["frame", "title"],
    ["dim", "contrast"],
    ["img", "alt"],
  ]);
  assert.ok(issues[1].ratio < issues[1].needed);
});

test("text on the dark board is checked against the board color", () => {
  const board = { nodes: [node("t", "text", 0, { text: "dark on dark", color: "#111111" })], connectors: [] };
  assert.deepEqual(accessibilityIssues(board).map((i) => i.kind), ["contrast"]);
});

test("describes objects and summarizes the board for screen readers", () => {
  const board = {
    nodes: [node("f", "frame", 0, { name: "Plan" }), node("s", "sticky", 10, { text: "Ship it", parentId: "f" }), node("i", "image", 400, {})],
    connectors: [{ id: "c" }],
  };
  assert.equal(describeObject(board.nodes[0], board), "Frame: Plan, 1 object");
  assert.equal(describeObject(board.nodes[1], board), "Sticky note: Ship it");
  assert.equal(describeObject(board.nodes[2], board), "Image, no description");
  assert.equal(boardSummary(board), "3 objects: 1 frame, 1 sticky note, 1 image; 1 connector.");
  assert.equal(boardSummary({ nodes: [], connectors: [] }), "The board is empty.");
});
