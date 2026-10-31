/**
 * Format v1 media objects and per-object links. The cases live in a fixture shared with the backend
 * serializer's tests, so both sides are held to the same expected output.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateCanvasState } from "./serialization";

const fixture = JSON.parse(
  readFileSync(new URL("../../../backend/apps/canvas/fixtures/format_v1_media.json", import.meta.url), "utf8")
);

for (const [name, { input, expected }] of Object.entries(fixture.cases)) {
  test(`format v1 media shared case: ${name}`, () => {
    assert.deepEqual(validateCanvasState(structuredClone(input)), expected);
  });
}

test("a validated media board round-trips unchanged", () => {
  for (const { expected } of Object.values(fixture.cases)) {
    const once = validateCanvasState(structuredClone(expected));
    assert.deepEqual(validateCanvasState(JSON.parse(JSON.stringify(once))), once);
  }
});
