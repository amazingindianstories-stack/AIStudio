/**
 * Unit tests for src/lib/canvas/history.ts — the pure undo/redo snapshot
 * stack reducer used by the Canvas Board (spec.md AC #8: "Undo/redo works
 * across at least node create/move/resize/delete/restyle operations").
 *
 * Derived independently from design.md's Interfaces section:
 *   interface History<T> { past: T[]; present: T; future: T[] }
 *   commit<T>(h, next): History<T>;   // push present->past, clear future, bounded (cap 50)
 *   undo<T>(h): History<T>;
 *   redo<T>(h): History<T>;
 * BEFORE reading any implementation. Pure module: no DOM, no network. Run:
 *   npx tsx --test src/lib/canvas/history.test.ts
 *
 * These tests use plain string/number "state" stand-ins (T is generic per
 * the interface) rather than full CanvasState fixtures, since history.ts's
 * contract is documented as generic over T and does not itself touch the
 * canvas node shape.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { commit, undo, redo } from "./history";

interface History<T> {
  past: T[];
  present: T;
  future: T[];
}

function h<T>(past: T[], present: T, future: T[]): History<T> {
  return { past, present, future };
}

// ---------------------------------------------------------------------------
// commit
// ---------------------------------------------------------------------------

test("commit: pushes the old present onto past and sets the new present", () => {
  const start = h<string>([], "s0", []);
  const result = commit(start, "s1");
  assert.deepEqual(result.past, ["s0"]);
  assert.equal(result.present, "s1");
});

test("commit: clears future even when it was non-empty (branching history)", () => {
  const start = h<string>(["s0"], "s1", ["s2", "s3"]);
  const result = commit(start, "s4");
  assert.deepEqual(result.past, ["s0", "s1"]);
  assert.equal(result.present, "s4");
  assert.deepEqual(result.future, []);
});

test("commit: does not mutate the input history object", () => {
  const start = h<string>(["s0"], "s1", ["s2"]);
  const before = JSON.parse(JSON.stringify(start));
  commit(start, "s4");
  assert.deepEqual(start, before);
});

test("commit: bounded depth — past never exceeds the documented cap of 50, dropping the oldest entries first", () => {
  const past = Array.from({ length: 50 }, (_, i) => `s${i}`); // s0 (oldest) ... s49 (newest before commit)
  const start = h<string>(past, "present-before", []);
  const result = commit(start, "next");

  assert.equal(result.past.length, 50, "past must stay capped at 50");
  assert.equal(result.past[0], "s1", "oldest entry (s0) must have been dropped");
  assert.equal(
    result.past[result.past.length - 1],
    "present-before",
    "the most recently committed old-present must be the newest entry in past"
  );
  assert.ok(!result.past.includes("s0"), "dropped entry must not remain anywhere in past");
});

test("commit: past below the cap simply grows by one, nothing dropped", () => {
  const past = Array.from({ length: 10 }, (_, i) => `s${i}`);
  const start = h<string>(past, "present-before", []);
  const result = commit(start, "next");
  assert.equal(result.past.length, 11);
  assert.equal(result.past[0], "s0");
  assert.equal(result.past[result.past.length - 1], "present-before");
});

// ---------------------------------------------------------------------------
// undo / redo — exact inverses
// ---------------------------------------------------------------------------

test("undo: moves present to the front of future and the last past entry becomes present", () => {
  const start = h<string>(["s0", "s1"], "s2", []);
  const result = undo(start);
  assert.equal(result.present, "s1");
  assert.deepEqual(result.past, ["s0"]);
  assert.deepEqual(result.future, ["s2"]);
});

test("redo: moves present to the end of past and the first future entry becomes present", () => {
  const start = h<string>(["s0"], "s1", ["s2"]);
  const result = redo(start);
  assert.equal(result.present, "s2");
  assert.deepEqual(result.past, ["s0", "s1"]);
  assert.deepEqual(result.future, []);
});

test("undo then redo returns to the exact original history (round trip)", () => {
  const start = h<string>(["s0", "s1"], "s2", ["s3", "s4"]);
  const result = redo(undo(start));
  assert.deepEqual(result, start);
});

test("redo then undo returns to the exact original history (round trip)", () => {
  const start = h<string>(["s0", "s1"], "s2", ["s3", "s4"]);
  const result = undo(redo(start));
  assert.deepEqual(result, start);
});

test("undo/redo full walk: commit twice, undo twice, redo twice returns to the same present at each mirrored step", () => {
  let hist = h<string>([], "s0", []);
  hist = commit(hist, "s1");
  hist = commit(hist, "s2");
  assert.equal(hist.present, "s2");
  assert.deepEqual(hist.past, ["s0", "s1"]);

  hist = undo(hist);
  assert.equal(hist.present, "s1");
  hist = undo(hist);
  assert.equal(hist.present, "s0");
  assert.deepEqual(hist.past, []);
  assert.deepEqual(hist.future, ["s1", "s2"]);

  hist = redo(hist);
  assert.equal(hist.present, "s1");
  hist = redo(hist);
  assert.equal(hist.present, "s2");
  assert.deepEqual(hist.future, []);
  assert.deepEqual(hist.past, ["s0", "s1"]);
});

// ---------------------------------------------------------------------------
// no-ops at the stack ends
// ---------------------------------------------------------------------------

test("undo: at an empty past is a no-op — does not throw, present/future unchanged", () => {
  const start = h<string>([], "s0", ["s1"]);
  assert.doesNotThrow(() => undo(start));
  const result = undo(start);
  assert.equal(result.present, "s0");
  assert.deepEqual(result.past, []);
  assert.deepEqual(result.future, ["s1"]);
});

test("redo: at an empty future is a no-op — does not throw, present/past unchanged", () => {
  const start = h<string>(["s0"], "s1", []);
  assert.doesNotThrow(() => redo(start));
  const result = redo(start);
  assert.equal(result.present, "s1");
  assert.deepEqual(result.past, ["s0"]);
  assert.deepEqual(result.future, []);
});

test("undo/redo on a completely empty history ({past:[],present,future:[]}) never throws or corrupts state", () => {
  const start = h<string>([], "only", []);
  assert.doesNotThrow(() => undo(start));
  assert.doesNotThrow(() => redo(start));
  assert.deepEqual(undo(start), start);
  assert.deepEqual(redo(start), start);
});

test("commit: does not mutate the input history's past/future arrays (immutability)", () => {
  const past = ["s0"];
  const future = ["s2"];
  const start = h<string>(past, "s1", future);
  commit(start, "s3");
  assert.deepEqual(past, ["s0"], "original past array reference must be untouched");
  assert.deepEqual(future, ["s2"], "original future array reference must be untouched");
});
