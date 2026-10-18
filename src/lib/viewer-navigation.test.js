import test from "node:test";
import assert from "node:assert/strict";
import {
  isNavigable,
  keyDelta,
  neighbourWindow,
  resolveStep,
  viewerList,
} from "./viewer-navigation.js";

const row = (id, extra = {}) => ({ id, kind: "image", status: "succeeded", url: `/api/media/generations/${id}.jpg`, ...extra });
const ids = (list) => list.map((item) => item.id);

test("only finished rows with media are navigable", () => {
  assert.equal(isNavigable(row("a")), true);
  assert.equal(isNavigable(row("a", { status: "failed" })), false);
  assert.equal(isNavigable(row("a", { status: "running" })), false);
  assert.equal(isNavigable(row("a", { url: null })), false);
  assert.equal(isNavigable(row("a", { url: null, poster: "/api/media/p.jpg" })), true);
  assert.equal(isNavigable(null), false);
});

test("a feed viewer lists exactly the rows the grid shows, in grid order", () => {
  // `items` is already one scope (folder, Unsorted, favourites, search...).
  const folder = [row("f3"), row("f2", { status: "failed" }), row("f1")];
  assert.deepEqual(ids(viewerList("feed", { items: folder, threadItems: [row("t1"), row("x9")] })), ["f3", "f1"]);
});

test("a thread viewer lists the thread in the order it is drawn (oldest first)", () => {
  const threadItems = [row("t3"), row("t2", { status: "failed" }), row("t1")]; // newest first, as loaded
  assert.deepEqual(ids(viewerList("thread", { items: [row("f1")], threadItems })), ["t1", "t3"]);
});

test("a single card has no list", () => {
  assert.deepEqual(viewerList("single", { items: [row("a"), row("b")] }), []);
});

test("Left/Up go back and Right/Down go forward", () => {
  assert.equal(keyDelta("ArrowLeft"), -1);
  assert.equal(keyDelta("ArrowUp"), -1);
  assert.equal(keyDelta("ArrowRight"), 1);
  assert.equal(keyDelta("ArrowDown"), 1);
  assert.equal(keyDelta("Enter"), 0);
});

test("Left/Right step one row in list order and wrap once the whole scope is loaded", () => {
  const list = [row("a"), row("b"), row("c")];
  assert.deepEqual(resolveStep({ list, currentId: "a", key: "ArrowRight" }), { id: "b" });
  assert.deepEqual(resolveStep({ list, currentId: "b", key: "ArrowLeft" }), { id: "a" });
  assert.deepEqual(resolveStep({ list, currentId: "c", key: "ArrowRight" }), { id: "a" });
  assert.deepEqual(resolveStep({ list, currentId: "a", key: "ArrowLeft" }), { id: "c" });
  assert.equal(resolveStep({ list: [row("a")], currentId: "a", key: "ArrowRight" }), null);
});

test("at the end of a loaded page with more pages, the step asks for the next page instead of wrapping", () => {
  const list = [row("a"), row("b")];
  assert.deepEqual(resolveStep({ list, currentId: "b", key: "ArrowRight", hasMore: true }), { more: true });
  assert.deepEqual(resolveStep({ list, currentId: "b", key: "ArrowDown", hasMore: true }), { more: true });
  // Off the start with pages still unloaded there is no real "other end": stay put.
  assert.equal(resolveStep({ list, currentId: "a", key: "ArrowLeft", hasMore: true }), null);
  // Once the last page is loaded, the end wraps within the same scope.
  assert.deepEqual(resolveStep({ list, currentId: "b", key: "ArrowRight", hasMore: false }), { id: "a" });
});

test("an asset that is not in the viewer's list goes nowhere", () => {
  assert.equal(resolveStep({ list: [row("a"), row("b")], currentId: "elsewhere", key: "ArrowRight" }), null);
  assert.equal(resolveStep({ list: [], currentId: "a", key: "ArrowRight" }), null);
});

test("Up/Down walk the card's own masonry column, skipping unviewable cards", () => {
  // reading order a b c d e f; two columns [a c e] [b d f] where c is a failed card
  const list = [row("a"), row("b"), row("d"), row("e"), row("f")];
  const columns = [["a", "c", "e"], ["b", "d", "f"]];
  assert.deepEqual(resolveStep({ list, columns, currentId: "a", key: "ArrowDown" }), { id: "e" });
  assert.deepEqual(resolveStep({ list, columns, currentId: "e", key: "ArrowUp" }), { id: "a" });
  assert.deepEqual(resolveStep({ list, columns, currentId: "d", key: "ArrowDown" }), { id: "f" });
  // Left/Right keep using reading order, not the column.
  assert.deepEqual(resolveStep({ list, columns, currentId: "a", key: "ArrowRight" }), { id: "b" });
});

test("Up/Down at a column end wrap inside the column, or load the next page when there is one", () => {
  const list = [row("a"), row("b"), row("c")];
  const columns = [["a", "c"], ["b"]];
  assert.deepEqual(resolveStep({ list, columns, currentId: "c", key: "ArrowDown" }), { id: "a" });
  assert.deepEqual(resolveStep({ list, columns, currentId: "a", key: "ArrowUp" }), { id: "c" });
  assert.equal(resolveStep({ list, columns, currentId: "b", key: "ArrowDown" }), null);
  assert.equal(resolveStep({ list, columns, currentId: "a", key: "ArrowUp", hasMore: true }), null);
  assert.deepEqual(resolveStep({ list, columns, currentId: "c", key: "ArrowDown", hasMore: true }), { more: true });
});

test("Up/Down fall back to reading order when no column holds the card (no grid mounted)", () => {
  const list = [row("a"), row("b")];
  assert.deepEqual(resolveStep({ list, columns: [], currentId: "a", key: "ArrowDown" }), { id: "b" });
  assert.deepEqual(resolveStep({ list, columns: [["x"]], currentId: "b", key: "ArrowUp" }), { id: "a" });
});

test("the preload window is nearest-first, ahead of the direction of travel before behind", () => {
  const list = ["a", "b", "c", "d", "e", "f"].map((id) => row(id));
  assert.deepEqual(ids(neighbourWindow(list, "c", 1, { ahead: 2, behind: 1 })), ["d", "b", "e"]);
  assert.deepEqual(ids(neighbourWindow(list, "c", -1, { ahead: 2, behind: 1 })), ["b", "d", "a"]);
  assert.deepEqual(ids(neighbourWindow(list, "a", -1, { ahead: 2, behind: 1 })), ["b"]);
  assert.deepEqual(neighbourWindow(list, "missing"), []);
});
