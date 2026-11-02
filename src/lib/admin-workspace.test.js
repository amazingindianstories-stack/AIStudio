import assert from "node:assert/strict";
import test from "node:test";
import { blankAnnouncement, parseUserIds, timeFromInput, timeToInput, toggleId } from "./admin-workspace.js";

test("toggleId keeps ids sorted and unique", () => {
  assert.deepEqual(toggleId(["b"], "a"), ["a", "b"]);
  assert.deepEqual(toggleId(["a", "b"], "a"), ["b"]);
  assert.deepEqual(toggleId(undefined, "x"), ["x"]);
});

test("parseUserIds splits pasted lists", () => {
  assert.deepEqual(parseUserIds("A, b\nb  c"), ["a", "b", "c"]);
  assert.deepEqual(parseUserIds(""), []);
});

test("times round trip through datetime-local text", () => {
  assert.equal(timeFromInput(""), null);
  assert.equal(timeFromInput("nope"), null);
  assert.equal(timeToInput(timeFromInput("2026-11-02T10:30")), "2026-11-02T10:30");
  assert.equal(timeToInput(null), "");
});

test("blank announcement defaults", () => {
  assert.equal(blankAnnouncement().priority, "info");
  assert.equal(blankAnnouncement().audience, "all");
});
