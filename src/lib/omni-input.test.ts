/**
 * Unit tests for buildOmniInput in src/lib/omni-input.ts — derived from
 * .council/omni-video/design.md Phase 1 (the pure builder that mirrors
 * providers/gemini.ts's buildParts) and spec.md AC2, independently of the
 * implementation's internals. Pure module: no network, no GOOGLE_API_KEY
 * required. Run:
 *   npx tsx --test src/lib/omni-input.test.ts
 *
 * NOTE: an earlier version of this file also tested a `duration` builder
 * option and an `omniTaskFor` export. Both were removed after re-probing the
 * live Interactions API (2026-07-11) showed `task` is not a recognized
 * request field at all, and `duration` is a real, enforced field that lives
 * under response_format (a request param), not prompt text — see
 * providers/omni.ts's header and .council/omni-video/decisions.md D11.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildOmniInput, OMNI_MAX_IMAGES, type OmniContentPart } from "./omni-input";
import type { AssembledPrompt } from "./prompt-assembler";

function textParts(parts: OmniContentPart[]): string[] {
  return parts.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text);
}

function imageCount(parts: OmniContentPart[]): number {
  return parts.filter((p) => p.type === "image").length;
}

function makeImage(tag: string) {
  return { mimeType: "image/png", data: `${tag}-data` };
}

test("OMNI_MAX_IMAGES is exported and equals 14", () => {
  assert.equal(OMNI_MAX_IMAGES, 14);
});

test("buildOmniInput: no groups falls back to the raw instruction with no SCENE prefix", () => {
  const assembled: AssembledPrompt = { instruction: "A dog runs in a field.", groups: [] };
  const parts = buildOmniInput(assembled);
  const texts = textParts(parts);
  assert.ok(texts.includes("A dog runs in a field."));
  assert.ok(!texts.some((t) => t.startsWith("SCENE:")));
});

test("buildOmniInput: with groups, wraps the instruction in a literal SCENE: prefix", () => {
  const assembled: AssembledPrompt = {
    instruction: "They dance.",
    groups: [{ tag: "@img1", header: "@img1 — REFERENCE:", images: [makeImage("a")] }],
  };
  const parts = buildOmniInput(assembled);
  assert.ok(textParts(parts).includes("SCENE: They dance."));
});

test("buildOmniInput: shotInstruction, when present, is used verbatim and NOT re-wrapped in another SCENE prefix", () => {
  const assembled: AssembledPrompt = {
    instruction: "raw prompt",
    shotInstruction: "SCENE: raw prompt\n\nAVOID: something",
    groups: [{ tag: "@img1", header: "hdr", images: [makeImage("a")] }],
  };
  const parts = buildOmniInput(assembled);
  const texts = textParts(parts);
  assert.ok(texts.includes("SCENE: raw prompt\n\nAVOID: something"));
  assert.equal(texts.filter((t) => t.startsWith("SCENE:")).length, 1);
});

test("buildOmniInput: group header precedes its images in output order", () => {
  const assembled: AssembledPrompt = {
    instruction: "x",
    groups: [{ tag: "@img1", header: "HEADER-1", images: [makeImage("a"), makeImage("b")] }],
  };
  const parts = buildOmniInput(assembled);
  const headerIdx = parts.findIndex((p) => p.type === "text" && p.text === "HEADER-1");
  const firstImageIdx = parts.findIndex((p) => p.type === "image");
  assert.ok(headerIdx >= 0 && firstImageIdx > headerIdx);
  assert.equal(imageCount(parts), 2);
});

test("buildOmniInput: throws loudly when user images exceed OMNI_MAX_IMAGES — never silently drops", () => {
  const images = Array.from({ length: OMNI_MAX_IMAGES + 1 }, (_, i) => makeImage(`img${i}`));
  const assembled: AssembledPrompt = {
    instruction: "x",
    groups: [{ tag: "@img1", header: "hdr", images }],
  };
  assert.throws(() => buildOmniInput(assembled), /Too many reference images/);
});

test("buildOmniInput: identity tiles yield first when the image budget is tight, user images never dropped", () => {
  const userImages = Array.from({ length: OMNI_MAX_IMAGES }, (_, i) => makeImage(`u${i}`));
  const tiles = [makeImage("tile1"), makeImage("tile2")];
  const assembled: AssembledPrompt = {
    instruction: "x",
    groups: [{ tag: "@img1", header: "hdr", images: userImages, identity: true, tiles }],
  };
  const parts = buildOmniInput(assembled);
  // All 14 user images present, zero budget left for tiles.
  assert.equal(imageCount(parts), OMNI_MAX_IMAGES);
});

test("buildOmniInput: identity tiles included when budget allows", () => {
  const userImages = [makeImage("u1")];
  const tiles = [makeImage("tile1"), makeImage("tile2")];
  const assembled: AssembledPrompt = {
    instruction: "x",
    groups: [{ tag: "@img1", header: "hdr", images: userImages, identity: true, tiles }],
  };
  const parts = buildOmniInput(assembled);
  assert.equal(imageCount(parts), 3); // 1 user image + 2 tiles
});

test("buildOmniInput: FINAL CHECK part present, video-worded, when any group is identity", () => {
  const assembled: AssembledPrompt = {
    instruction: "x",
    groups: [{ tag: "@img1", header: "hdr", images: [makeImage("a")], identity: true }],
  };
  const parts = buildOmniInput(assembled);
  const finalCheck = textParts(parts).find((t) => t.startsWith("FINAL CHECK"));
  assert.ok(finalCheck);
  assert.ok(/every frame of the video/i.test(finalCheck as string));
});

test("buildOmniInput: no FINAL CHECK part when no group is identity", () => {
  const assembled: AssembledPrompt = {
    instruction: "x",
    groups: [{ tag: "@img1", header: "hdr", images: [makeImage("a")], identity: false }],
  };
  const parts = buildOmniInput(assembled);
  assert.ok(!textParts(parts).some((t) => t.startsWith("FINAL CHECK")));
});
