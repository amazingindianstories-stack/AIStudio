import assert from "node:assert/strict";
import test from "node:test";
import { findOnBoard, matchCount, replaceMatches, shiftMarks } from "./find.js";

const node = (id, type, x, extra) => ({ id, type, x, y: 0, w: 100, h: 100, parentId: null, groupId: null, ...extra });

const board = {
  nodes: [
    node("s2", "sticky", 300, { text: "Launch plan, launch day" }),
    node("s1", "sticky", 0, { text: "Plan the LAUNCH" }),
    node("r", "rect", 600, { text: "launch" }),
    node("f", "frame", 900, { name: "Launch frame" }),
    node("img", "image", 1200, { alt: "Rocket launch photo" }),
    node("t", "text", 1500, { text: "nothing here" }),
  ],
  connectors: [],
};

test("finds every searchable field in reading order, ignoring case by default", () => {
  const hits = findOnBoard(board, "launch");
  assert.deepEqual(hits.map((h) => [h.id, h.field]), [
    ["s1", "text"],
    ["s2", "text"],
    ["r", "text"],
    ["f", "name"],
    ["img", "alt"],
  ]);
  assert.deepEqual(hits[1].ranges, [[0, 6], [13, 19]]);
  assert.equal(matchCount(hits), 6);
});

test("type filters and match case narrow the search", () => {
  assert.deepEqual(findOnBoard(board, "launch", { types: ["shape", "image"] }).map((h) => h.id), ["r", "img"]);
  assert.deepEqual(findOnBoard(board, "LAUNCH", { matchCase: true }).map((h) => h.id), ["s1"]);
  assert.deepEqual(findOnBoard(board, ""), []);
});

test("replace all edits every hit, keeping other text", () => {
  const hits = findOnBoard(board, "launch");
  const edits = replaceMatches(board, hits, "release");
  assert.equal(edits.get("s2").text, "release plan, release day");
  assert.equal(edits.get("s1").text, "Plan the release");
  assert.equal(edits.get("f").name, "release frame");
  assert.equal(edits.get("img").alt, "Rocket release photo");
  assert.equal(edits.has("t"), false);
});

test("replace one edits only the first match of the target object", () => {
  const hits = findOnBoard(board, "launch");
  const edits = replaceMatches(board, hits, "go", { id: "s2", index: 0 });
  assert.deepEqual([...edits.keys()], ["s2"]);
  assert.equal(edits.get("s2").text, "go plan, launch day");
});

test("rich text marks follow the replaced text", () => {
  const rich = { nodes: [node("s", "sticky", 0, { text: "ab launch cd", marks: [[0, 2, "bold"], [3, 9, "italic"], [10, 12, "bold"]] })], connectors: [] };
  const edits = replaceMatches(rich, findOnBoard(rich, "launch"), "go");
  assert.equal(edits.get("s").text, "ab go cd");
  assert.deepEqual(edits.get("s").marks, [[0, 2, "bold"], [3, 5, "italic"], [6, 8, "bold"]]);
});

test("shiftMarks cuts partly covered ranges and drops ranges inside the replaced text", () => {
  assert.deepEqual(shiftMarks([[0, 5, "b"]], 3, 8, 1), [[0, 3, "b"]]);
  assert.deepEqual(shiftMarks([[4, 10, "b"]], 2, 6, 0), [[2, 6, "b"]]);
  assert.deepEqual(shiftMarks([[3, 5, "b"]], 2, 6, 3), []);
  assert.equal(shiftMarks(undefined, 0, 1, 1), undefined);
});
