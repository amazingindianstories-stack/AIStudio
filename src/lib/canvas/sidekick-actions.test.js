import assert from "node:assert/strict";
import test from "node:test";
import { applyActions, summarize, MAX_ACTIONS } from "./sidekick-actions.js";
import { validateCanvasState } from "./serialization.js";

const sticky = (id, extra = {}) => ({ id, type: "sticky", x: 0, y: 0, w: 200, h: 200, text: id, fill: "#e3c56a", fontSize: 16, color: "#1c1a12", opacity: 1, parentId: null, groupId: null, ...extra });
const board = (nodes, connectors = []) => ({ version: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes, connectors });

test("adds objects marked as AI-created and connects them by ref", () => {
  const present = board([sticky("a")]);
  const result = applyActions(present, [
    { op: "add", type: "sticky", ref: "n1", text: "One", color: "pink" },
    { op: "add", type: "rect", ref: "n2", text: "Two" },
    { op: "connect", from: "n1", to: "n2" },
    { op: "connect", from: "a", to: "n1" },
  ], { center: { x: 1000, y: 1000 }, now: 5 });
  assert.equal(result.added.length, 2);
  assert.equal(result.next.nodes.filter((n) => n.aiCreated).length, 2);
  assert.equal(result.next.connectors.length, 2);
  assert.equal(result.next.nodes.find((n) => n.text === "One").fill, "#d189a7");
  assert.equal(result.next.nodes.find((n) => n.text === "Two").aiEditedAt, 5);
});

test("leaves a result the server accepts after normalization", () => {
  const result = applyActions(board([]), [{ op: "add", type: "frame", text: "Plan" }, { op: "add", type: "text", text: "Hi" }, { op: "add", type: "ellipse" }, { op: "add", type: "diamond" }]);
  const parsed = validateCanvasState(result.next);
  assert.equal(parsed.nodes.length, 4);
});

test("adds and recolours objects in any requested colour", () => {
  const present = board([sticky("a")]);
  const added = applyActions(present, [{ op: "add", type: "sticky", text: "Dark", color: "black" }, { op: "add", type: "sticky", text: "Hex", fill: "#FF00AA" },
    { op: "update", id: "a", color: "black" }]);
  const [a, dark, hex] = [...added.next.nodes.filter((node) => node.id === "a"), ...added.next.nodes.filter((node) => node.id !== "a")];
  assert.deepEqual([a, dark, hex].map((node) => [node.fill, node.color]), [["#1a1a1a", "#f5f5f5"], ["#1a1a1a", "#f5f5f5"], ["#ff00aa", "#1c1a12"]]);
});

test("updates and deletes only unlocked objects the board holds", () => {
  const present = board([sticky("a"), sticky("b", { locked: true }), sticky("c")], [{ id: "k", from: { nodeId: "c", anchor: "auto" }, to: { nodeId: "a", anchor: "auto" }, kind: "arrow", stroke: "#000", strokeWidth: 2 }]);
  const result = applyActions(present, [
    { op: "update", id: "a", text: "New", x: 40 },
    { op: "update", id: "b", text: "Nope" },
    { op: "update", id: "ghost", text: "Nope" },
    { op: "delete", id: "c" },
    { op: "delete", id: "b" },
  ]);
  assert.deepEqual(result.next.nodes.map((n) => n.id), ["a", "b"]);
  assert.partialDeepStrictEqual(result.next.nodes[0], { text: "New", x: 40 });
  assert.equal(typeof result.next.nodes[0].aiEditedAt, "number");
  assert.equal(result.next.nodes[1].text, "b");
  assert.deepEqual(result.next.connectors, []);
  assert.equal(result.skipped, 3);
  assert.equal(summarize(result), "changed 1, deleted 1, skipped 3");
});

test("places unpositioned objects clear of existing ones and keeps explicit positions", () => {
  const present = board([sticky("a", { x: 900, y: 900 })]);
  const result = applyActions(present, [{ op: "add", type: "sticky", text: "x" }, { op: "add", type: "sticky", text: "y", x: 5, y: 6 }], { center: { x: 1000, y: 1000 } });
  const [x, y] = [result.next.nodes[1], result.next.nodes[2]];
  assert.equal(x.x < 1100 && x.x + x.w > 900 && x.y < 1100 && x.y + x.h > 900, false);
  assert.partialDeepStrictEqual(y, { x: 5, y: 6 });
});

test("drops connects to missing or deleted ends and caps the action count", () => {
  const present = board([sticky("a"), sticky("b")]);
  const none = applyActions(present, [{ op: "delete", id: "b" }, { op: "connect", from: "a", to: "b" }]);
  assert.deepEqual(none.next.connectors, []);
  const many = applyActions(board([]), Array.from({ length: MAX_ACTIONS + 10 }, () => ({ op: "add", type: "sticky", text: "n" })));
  assert.equal(many.added.length, MAX_ACTIONS);
});

test("returns the same state when nothing applies", () => {
  const present = board([sticky("a")]);
  assert.equal(applyActions(present, [{ op: "update", id: "zzz", text: "q" }]).next, present);
  assert.equal(applyActions(present, []).next, present);
});
