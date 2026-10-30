import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bulkStickies,
  clusterGroups,
  clusterLayout,
  limitCells,
  parseTsv,
  stickiesCsv,
  stickiesFromGrid,
  stickyColorPatch,
  stickyFromStack,
  stickyShape,
  withStickyShape,
} from "./stickies";

const sticky = (id, extra = {}) => ({ id, type: "sticky", x: 0, y: 0, w: 200, h: 200, text: id, fill: "#e3c56a", fontSize: 16, color: "#1c1a12", ...extra });

test("the sticky palette sets a readable ink unless the text color is custom", () => {
  assert.deepEqual(stickyColorPatch(sticky("a"), "#3a3a3a"), { fill: "#3a3a3a", color: "#f5f5f5" });
  assert.deepEqual(stickyColorPatch(sticky("a", { color: "#ff0000" }), "#3a3a3a"), { fill: "#3a3a3a" });
});

test("square and rectangle keep the sticky's height and corner", () => {
  const rect = withStickyShape(sticky("a"), "rectangle");
  assert.deepEqual([rect.x, rect.y, rect.w, rect.h, stickyShape(rect)], [0, 0, 350, 200, "rectangle"]);
  assert.equal(stickyShape(withStickyShape(rect, "square")), "square");
});

test("bulk mode makes one sticky per non-blank line in a near-square grid", () => {
  const nodes = bulkStickies("one\n\n two \nthree\r\nfour\nfive", { x: 0, y: 0 }, { autoFit: true });
  assert.deepEqual(nodes.map((n) => n.text), ["one", "two", "three", "four", "five"]);
  assert.deepEqual(nodes.map((n) => [n.x, n.y]), [[-320, -210], [-100, -210], [120, -210], [-320, 10], [-100, 10]]);
  assert.ok(nodes.every((n) => n.autoFit === true && n.type === "sticky"));
  assert.equal(new Set(nodes.map((n) => n.id)).size, 5);
});

test("tab-separated cells parse with quoted cells, and plain text is not cells", () => {
  assert.equal(parseTsv("just a line"), null);
  assert.deepEqual(parseTsv("a\tb\nc\td\n"), [["a", "b"], ["c", "d"]]);
  assert.deepEqual(parseTsv('"two\nlines"\t"say ""hi"""\r\n\tlast'), [["two\nlines", 'say "hi"'], ["", "last"]]);
  assert.deepEqual(parseTsv('5" screen\tx'), [['5" screen', "x"]]);
});

test("pasted cells keep their grid, skip blank cells and stop at the limits", () => {
  const nodes = stickiesFromGrid([["a", ""], ["", "d"]], { x: 0, y: 0 }, {});
  assert.deepEqual(nodes.map((n) => [n.text, n.x, n.y]), [["a", -210, -210], ["d", 10, 10]]);
  const big = Array.from({ length: 60 }, () => Array.from({ length: 120 }, () => "x"));
  const { rows, truncated } = limitCells(big);
  assert.deepEqual([rows.length, rows[0].length, truncated], [50, 100, true]);
  assert.equal(limitCells([["a"]]).truncated, false);
});

test("a stack hands out a blank sticky in its color, centered on the drop point", () => {
  const node = stickyFromStack({ fill: "#3a3a3a" }, { x: 100, y: 100 }, { autoFit: true });
  assert.deepEqual([node.x, node.y, node.text, node.fill, node.color, node.autoFit], [0, 0, "", "#3a3a3a", "#f5f5f5", true]);
});

test("CSV export quotes cells, guards formulas and names tags and authors", () => {
  const tags = [{ id: "t1", name: "Idea", color: "#ef4444" }, { id: "t2", name: "Now", color: "#3b82f6" }];
  const csv = stickiesCsv(
    [sticky("a", { text: 'Say "hi", then\nleave', tagIds: ["t2", "t1"], createdBy: "u1", textBy: "u2" }),
      { id: "x", type: "text", text: "skip" },
      sticky("b", { text: "=SUM(A1)", fill: "#123456" })],
    tags,
    (id) => ({ u1: "Ana", u2: "Ben" })[id],
  );
  assert.equal(csv, '﻿Text,Color,Tags,Author\r\n"Say ""hi"", then\nleave",Yellow,Now; Idea,Ben\r\n\'=SUM(A1),#123456,,\r\n');
});

test("clustering groups by a sticky's first tag, color or author with the leftovers last", () => {
  const tags = [{ id: "t1", name: "Idea", color: "#ef4444" }, { id: "t2", name: "Now", color: "#3b82f6" }];
  const nodes = [sticky("a", { tagIds: ["t2"] }), sticky("b"), sticky("c", { tagIds: ["t2", "t1"] }), sticky("d", { tagIds: ["t1"] })];
  const byTag = clusterGroups(nodes, "tag", { tags });
  assert.deepEqual(byTag.map((g) => [g.title, g.nodes.map((n) => n.id)]), [["Idea", ["d"]], ["Now", ["a", "c"]], ["No tag", ["b"]]]);
  const byColor = clusterGroups([sticky("a", { fill: "#3A3A3A" }), sticky("b")], "color");
  assert.deepEqual(byColor.map((g) => g.title), ["Yellow", "Charcoal"]);
  const byAuthor = clusterGroups([sticky("a", { createdBy: "u2" }), sticky("b"), sticky("c", { createdBy: "u1" })], "author",
    { personName: (id) => ({ u1: "Zed", u2: "Amy" })[id] });
  assert.deepEqual(byAuthor.map((g) => g.title), ["Amy", "Zed", "Unknown author"]);
});

test("cluster layout places titled grids left to right", () => {
  const groups = [{ title: "Idea", nodes: [sticky("a"), sticky("b")] }, { title: "Now", nodes: [sticky("c")] }];
  const { positions, titles } = clusterLayout(groups, { x: 0, y: 0 }, { color: "#ffffff" });
  assert.deepEqual(Object.fromEntries(positions), { a: { x: 0, y: 52 }, b: { x: 220, y: 52 }, c: { x: 500, y: 52 } });
  assert.deepEqual(titles.map((t) => [t.text, t.x, t.marks]), [["Idea (2)", 0, [[0, 8, "b"]]], ["Now (1)", 500, [[0, 7, "b"]]]]);
});
