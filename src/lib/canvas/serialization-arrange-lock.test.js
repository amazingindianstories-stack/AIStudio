/**
 * Format v1 rotation, locks, layers and board settings. The cases live in a
 * fixture shared with the backend serializer's tests (test_locks.py), so both
 * sides are held to the same expected output.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateCanvasState } from "./serialization";

const fixture = JSON.parse(
  readFileSync(new URL("../../../backend/apps/canvas/fixtures/format_v1_arrange_lock.json", import.meta.url), "utf8")
);

for (const [name, { input, expected }] of Object.entries(fixture.cases)) {
  test(`format v1 arrange and lock shared case: ${name}`, () => {
    assert.deepEqual(validateCanvasState(structuredClone(input)), expected);
  });
}

test("validated boards with rotation, locks and layers round-trip unchanged", () => {
  for (const { expected } of Object.values(fixture.cases)) {
    const once = validateCanvasState(structuredClone(expected));
    assert.deepEqual(validateCanvasState(JSON.parse(JSON.stringify(once))), once);
    assert.deepEqual(once, expected);
  }
});

test("boards without settings gain no settings key", () => {
  for (const name of ["rotation", "locks", "invalid-settings", "settings-not-object"]) {
    assert.equal("settings" in validateCanvasState(structuredClone(fixture.cases[name].input)), false, name);
  }
});
