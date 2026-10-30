/**
 * Format v1 sticky, tag, reaction and font fields. The cases live in a fixture
 * shared with the backend serializer's tests, so both sides are held to the
 * same expected output.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateCanvasState } from "./serialization";

const fixture = JSON.parse(
  readFileSync(new URL("../../../backend/apps/canvas/fixtures/format_v1_stickies_tags.json", import.meta.url), "utf8")
);

for (const [name, { input, expected }] of Object.entries(fixture.cases)) {
  test(`format v1 shared case: ${name}`, () => {
    assert.deepEqual(validateCanvasState(structuredClone(input)), expected);
  });
}

test("a validated board with the new fields round-trips unchanged", () => {
  for (const { expected } of Object.values(fixture.cases)) {
    const once = validateCanvasState(structuredClone(expected));
    assert.deepEqual(validateCanvasState(JSON.parse(JSON.stringify(once))), once);
  }
});

test("a board without the new fields keeps its exact JSON", () => {
  const { input, expected } = fixture.cases.legacy_board_keeps_its_shape;
  assert.equal(JSON.stringify(validateCanvasState(structuredClone(input))), JSON.stringify(expected));
});
