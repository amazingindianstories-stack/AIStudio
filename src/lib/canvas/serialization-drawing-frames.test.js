/**
 * Format v1 ink, grid, synced copy, hidden frame and visual notes fields. The cases live in a fixture
 * shared with the backend serializer's tests, so both sides are held to the
 * same expected output.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateCanvasState } from "./serialization";

const fixture = JSON.parse(
  readFileSync(new URL("../../../backend/apps/canvas/fixtures/format_v1_drawing_frames.json", import.meta.url), "utf8")
);

for (const [name, { input, expected }] of Object.entries(fixture.cases)) {
  test(`format v1 shared case: ${name}`, () => {
    assert.deepEqual(validateCanvasState(structuredClone(input)), expected);
  });
}

test("a validated board with the drawing and frame fields round-trips unchanged", () => {
  for (const { expected } of Object.values(fixture.cases)) {
    const once = validateCanvasState(structuredClone(expected));
    assert.deepEqual(validateCanvasState(JSON.parse(JSON.stringify(once))), once);
  }
});

test("a board without the new fields keeps its exact JSON", () => {
  const { input, expected } = fixture.cases.legacy_board_keeps_its_shape;
  assert.equal(JSON.stringify(validateCanvasState(structuredClone(input))), JSON.stringify(expected));
});

test("the visual notes travel in patches whole and null removes them", async () => {
  const { buildBoardPatch, applyBoardPatch } = await import("./patch");
  const base = validateCanvasState({ nodes: [], connectors: [] });
  const next = validateCanvasState({ nodes: [], connectors: [], notes: { text: "plan" } });
  const patch = buildBoardPatch(base, next);
  assert.deepEqual(patch.notes, { text: "plan" });
  assert.deepEqual(applyBoardPatch(base, patch).notes, { text: "plan" });
  const removed = buildBoardPatch(next, base);
  assert.equal(removed.notes, null);
  assert.equal("notes" in applyBoardPatch(next, removed), false);
  assert.equal("notes" in buildBoardPatch(next, next), false);
});

test("a three-way merge keeps this editor's notes change over theirs and takes theirs when only they changed", async () => {
  const { mergeCanvasStates } = await import("./merge");
  const base = validateCanvasState({ nodes: [], connectors: [], notes: { text: "a" } });
  const local = validateCanvasState({ nodes: [], connectors: [], notes: { text: "mine" } });
  const remote = validateCanvasState({ nodes: [], connectors: [], notes: { text: "theirs" } });
  assert.equal(mergeCanvasStates(base, local, remote).notes.text, "mine");
  assert.equal(mergeCanvasStates(base, base, remote).notes.text, "theirs");
  assert.equal("notes" in mergeCanvasStates(base, base, validateCanvasState({ nodes: [], connectors: [] })), false);
});
