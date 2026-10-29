/**
 * Format v1 additions: the generic `shape` node and rich-text `marks`. The
 * cases live in a fixture shared with the backend serializer's tests, so
 * both sides are held to the same expected output.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateCanvasState } from "./serialization";
import { MAX_MARKS } from "./rich-text";

const fixture = JSON.parse(
  readFileSync(new URL("../../../backend/apps/canvas/fixtures/format_v1_shapes_rich_text.json", import.meta.url), "utf8")
);

for (const [name, { input, expected }] of Object.entries(fixture.cases)) {
  test(`format v1 shared case: ${name}`, () => {
    assert.deepEqual(validateCanvasState(structuredClone(input)), expected);
  });
}

test("a validated board with shapes and marks round-trips unchanged", () => {
  for (const { expected } of Object.values(fixture.cases)) {
    const once = validateCanvasState(structuredClone(expected));
    assert.deepEqual(validateCanvasState(JSON.parse(JSON.stringify(once))), once);
    assert.deepEqual(once, expected);
  }
});

test("plain-text boards gain no marks key and keep their exact JSON", () => {
  const { input, expected } = fixture.cases.legacy;
  const out = validateCanvasState(structuredClone(input));
  assert.equal(JSON.stringify(out), JSON.stringify(expected));
  for (const node of out.nodes) assert.equal("marks" in node, false);
});

test("marks beyond the per-node cap are dropped, the first ones kept", () => {
  const text = "x".repeat(10);
  const marks = Array.from({ length: MAX_MARKS + 5 }, (_, i) => [i % 10, (i % 10) + 1, "b"]);
  const out = validateCanvasState({ nodes: [{ id: "n", type: "text", x: 0, y: 0, w: 1, h: 1, text, marks }] });
  assert.equal(out.nodes[0].marks.length, MAX_MARKS);
  assert.deepEqual(out.nodes[0].marks.at(-1), marks[MAX_MARKS - 1]);
});
