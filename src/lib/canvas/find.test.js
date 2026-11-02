import assert from "node:assert/strict";
import test from "node:test";
import { findOnBoard, matchCount, replaceMatches, replaceOneMatch, shiftMarks } from "./find.js";

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
  const edits = replaceMatches(board, hits, "go", { id: "s2", field: "text", index: 0 });
  assert.deepEqual([...edits.keys()], ["s2"]);
  assert.equal(edits.get("s2").text, "go plan, launch day");
});

test("replace one moves past its new text, so a replacement containing the query is not replaced again", () => {
  let present = { nodes: [node("a", "sticky", 0, { text: "cat and cat" }), node("b", "sticky", 300, { text: "a cat" })], connectors: [] };
  let hits = findOnBoard(present, "cat");
  let at = { hit: 0, range: 0 };
  const texts = [];
  for (let i = 0; i < 4; i += 1) {
    const done = replaceOneMatch(present, hits, at, "cats", "cat");
    present = { ...present, nodes: present.nodes.map((n) => done.edits.get(n.id) ?? n) };
    ({ hits, at } = done);
    texts.push(present.nodes.map((n) => n.text).join(" | "));
  }
  assert.deepEqual(texts, [
    "cats and cat | a cat",
    "cats and cats | a cat",
    "cats and cats | a cats",
    "catss and cats | a cats",
  ]);
});

test("replace one replaces the match it is on and moves on when the object stops matching", () => {
  const present = { nodes: [node("a", "sticky", 0, { text: "cat cat" }), node("b", "sticky", 300, { text: "cat" })], connectors: [] };
  const hits = findOnBoard(present, "cat");
  const second = replaceOneMatch(present, hits, { hit: 0, range: 1 }, "dog", "cat");
  assert.equal(second.edits.get("a").text, "cat dog");
  assert.deepEqual(second.at, { hit: 1, range: 0 });
  const last = replaceOneMatch(present, hits, { hit: 1, range: 0 }, "dog", "cat");
  assert.deepEqual(last.at, { hit: 0, range: 0 });
  const only = { nodes: [node("a", "sticky", 0, { text: "cat" })], connectors: [] };
  assert.equal(replaceOneMatch(only, findOnBoard(only, "cat"), { hit: 0, range: 0 }, "dog", "cat").at, null);
});

const diagrams = {
  nodes: [
    node("erd", "erd", 0, { name: "users", columns: 2, rows: [{ id: "r1", cells: ["user_id", "uuid", "PK user"] }, { id: "r2", cells: ["email", "text", ""] }] }),
    node("lane", "swimlane", 300, { name: "Sales user flow", lanes: [{ id: "l1", name: "Buyer" }, { id: "l2", name: "Admin user" }] }),
    node("dia", "diagram", 600, { name: "User system" }),
    node("note", "sticky", 900, { text: "nothing" }),
  ],
  connectors: [
    { id: "c", from: { nodeId: "erd" }, to: { nodeId: "dia" }, kind: "arrow", labels: [{ id: "l", text: "owns user", position: 0.5 }] },
    { id: "bare", from: { nodeId: "erd" }, to: { nodeId: "lane" }, kind: "line" },
  ],
};

test("finds the visible text of ERD tables, swimlanes, diagrams and connector labels", () => {
  const hits = findOnBoard(diagrams, "user");
  assert.deepEqual(hits.map((h) => [h.id, h.field]), [
    ["erd", "name"],
    ["erd", "rows.0.cells.0"],
    ["c", "labels.0.text"],
    ["lane", "name"],
    ["lane", "lanes.1.name"],
    ["dia", "name"],
  ]);
  // A two-column table hides the third cell, so "PK user" is not searched.
  assert.equal(findOnBoard(diagrams, "PK").length, 0);
  assert.deepEqual(findOnBoard(diagrams, "user", { types: ["connector"] }).map((h) => h.id), ["c"]);
  assert.deepEqual([...new Set(findOnBoard(diagrams, "user", { types: ["diagram"] }).map((h) => h.id))], ["erd", "lane", "dia"]);
});

test("replace edits exactly the fields find matched, connectors included", () => {
  const edits = replaceMatches(diagrams, findOnBoard(diagrams, "user"), "member");
  assert.deepEqual([...edits.keys()].sort(), ["c", "dia", "erd", "lane"]);
  assert.equal(edits.get("erd").name, "members");
  assert.deepEqual(edits.get("erd").rows.map((r) => r.cells), [["member_id", "uuid", "PK user"], ["email", "text", ""]]);
  assert.deepEqual(edits.get("lane").lanes.map((l) => l.name), ["Buyer", "Admin member"]);
  assert.equal(edits.get("lane").name, "Sales member flow");
  assert.equal(edits.get("dia").name, "member system");
  assert.equal(edits.get("c").labels[0].text, "owns member");
  // The originals are untouched.
  assert.equal(diagrams.nodes[0].rows[0].cells[0], "user_id");
  assert.equal(diagrams.connectors[0].labels[0].text, "owns user");
});

test("replace one steps from a table's name to its cells and on to the next object", () => {
  let present = diagrams;
  let hits = findOnBoard(present, "user");
  const done = replaceOneMatch(present, hits, { hit: 0, range: 0 }, "users", "user");
  assert.deepEqual([...done.edits.keys()], ["erd"]);
  assert.equal(done.edits.get("erd").name, "userss");
  assert.deepEqual([done.hits[done.at.hit].id, done.hits[done.at.hit].field], ["erd", "rows.0.cells.0"]);
  present = { ...present, nodes: present.nodes.map((n) => done.edits.get(n.id) ?? n) };
  hits = done.hits;
  const next = replaceOneMatch(present, hits, done.at, "x", "user");
  assert.equal(next.edits.get("erd").rows[0].cells[0], "x_id");
  // The cell no longer matches, so the next object's first match takes its place.
  assert.deepEqual([next.hits[next.at.hit].id, next.hits[next.at.hit].field], ["c", "labels.0.text"]);
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
