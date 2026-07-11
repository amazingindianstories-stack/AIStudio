import test from "node:test";
import assert from "node:assert/strict";
import { buildParts } from "./providers/gemini";
import { buildCastPolicy } from "./shot-spec";

const FINAL_CHECK =
  "FINAL CHECK: every person referenced above must be a 1:1 photographic " +
  "match to their reference images (bone structure, eyes, nose, lips, " +
  "jawline, skin tone, apparent age). If not, correct it.";

test("Gemini parts: location reference gets zero-cast policy and no face final check", () => {
  const instruction =
    "An empty school hallway, camera looking down from the upper landing.";
  const shotInstruction = `SCENE: ${instruction}\n\nAVOID: unrequested people.`;
  const header = "@img1 — LOCATION reference (1 image): exact school.";
  const parts = buildParts({
    instruction,
    shotInstruction,
    groups: [
      {
        tag: "@img1",
        header,
        images: [{ mimeType: "image/png", data: "location" }],
        identity: false,
      },
    ],
  });

  assert.deepEqual(parts, [
    { text: header },
    { inlineData: { mimeType: "image/png", data: "location" } },
    { text: shotInstruction },
    { text: buildCastPolicy(instruction, false) as string },
  ]);
  assert.equal(
    parts.some((part) => part.text?.startsWith("FINAL CHECK:")),
    false
  );
});

test("Gemini parts: identity order and final check remain byte-identical", () => {
  const instruction = "A cinematic scene at sunset.";
  const shotInstruction = `SCENE: ${instruction}`;
  const header = "SUBJECT — FACE/IDENTITY reference.";
  const parts = buildParts({
    instruction,
    shotInstruction,
    groups: [
      {
        tag: "SUBJECT",
        header,
        images: [{ mimeType: "image/jpeg", data: "raw-face" }],
        tiles: [{ mimeType: "image/jpeg", data: "face-tile" }],
        identity: true,
      },
    ],
  });

  assert.deepEqual(parts, [
    { text: header },
    { inlineData: { mimeType: "image/jpeg", data: "raw-face" } },
    { inlineData: { mimeType: "image/jpeg", data: "face-tile" } },
    { text: shotInstruction },
    { text: FINAL_CHECK },
  ]);
});

test("Gemini parts: explicit text-only person prompt is not given zero-cast text", () => {
  const instruction = "A teacher looking down at an open book.";
  assert.deepEqual(buildParts({ instruction, groups: [] }), [
    { text: instruction },
  ]);
});

test("Gemini parts: text-only empty location is protected even without shot-spec", () => {
  const instruction = "An empty school, looking down from above.";
  assert.deepEqual(buildParts({ instruction, groups: [] }), [
    { text: instruction },
    { text: buildCastPolicy(instruction, false) as string },
  ]);
});
