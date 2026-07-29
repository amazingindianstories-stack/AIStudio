import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_REFERENCE_VIDEOS,
  MODELS,
  supportsAudio,
  supportsVideoReference,
} from "./config";

/**
 * `supportsAudio` decides whether the composer offers an audio toggle at all,
 * and the video route uses it to decide whether to honour the request. Getting
 * it wrong is silent in both directions — a false positive shows a control the
 * provider ignores, a false negative hides a capability the user is paying for
 * — so the substring traps get their own tests.
 */

test("BytePlus ModelArk Seedance is the audio-capable path", () => {
  assert.equal(supportsAudio("Seedance 2.0"), true);
  assert.equal(supportsAudio("Seedance 2.0 Mini"), true);
});

test("Higgsfield Seedance does NOT get an audio toggle", () => {
  // The trap this exists for: "Higgsfield Seedance 2.0" contains "seedance",
  // so a bare /seedance/ test would offer audio on a path whose MCP tools have
  // no audio parameter at all.
  assert.equal(supportsAudio("Higgsfield Seedance 2.0"), false);
  assert.equal(supportsAudio("Higgsfield Seedance 2.0 Mini"), false);
});

test("Omni video has no audio field either", () => {
  assert.equal(supportsAudio("Gemini Omni Flash"), false);
});

test("image models never claim audio support", () => {
  assert.equal(supportsAudio("Nano Banana Pro"), false);
  assert.equal(supportsAudio("Higgsfield Soul"), false);
});

test("matching is case-insensitive", () => {
  assert.equal(supportsAudio("seedance 2.0"), true);
  assert.equal(supportsAudio("HIGGSFIELD SEEDANCE 2.0"), false);
});

test("every model in the picker resolves without throwing", () => {
  // Cheap guard against a future model name landing in an undefined state.
  for (const m of MODELS) {
    assert.equal(typeof supportsAudio(m.name), "boolean", m.name);
  }
});

test("exactly one model in the picker is audio-capable today", () => {
  // Only "Seedance 2.0" (BytePlus direct) is offered in the UI. The BytePlus
  // mini SKU exists in the provider (pickModel routes mini/fast to
  // SEEDANCE_MODEL_FAST) and has a pricing row, but it has never been added to
  // MODELS — the "Mini" entry in the picker is Higgsfield's, which is a
  // different vendor and has no audio parameter. If a native mini is ever
  // added to the picker this assertion should be updated, not deleted.
  const capable = MODELS.filter((m) => supportsAudio(m.name)).map((m) => m.name);
  assert.deepEqual(capable, ["Seedance 2.0"]);
});

test("no image model is ever audio-capable", () => {
  for (const m of MODELS.filter((m) => m.kind === "image")) {
    assert.equal(supportsAudio(m.name), false, m.name);
  }
});

// ── video-to-video gating ───────────────────────────────────────────────────

test("BytePlus Seedance is the video-reference path", () => {
  assert.equal(supportsVideoReference("Seedance 2.0"), true);
  assert.equal(supportsVideoReference("Seedance 2.0 Mini"), true);
});

test("Higgsfield Seedance does NOT accept a video reference", () => {
  // Same substring trap as supportsAudio: the Higgsfield names contain
  // "seedance", and its MCP has no video-reference parameter, so a bare
  // /seedance/ test would attach clips the provider silently drops.
  assert.equal(supportsVideoReference("Higgsfield Seedance 2.0"), false);
  assert.equal(supportsVideoReference("Higgsfield Seedance 2.0 Mini"), false);
});

test("Omni and image models take no video reference", () => {
  assert.equal(supportsVideoReference("Gemini Omni Flash"), false);
  assert.equal(supportsVideoReference("Nano Banana Pro"), false);
});

test("audio and video-reference support agree on which models are native", () => {
  // Both gate on the same thing — the native BytePlus path — so a future model
  // that diverges should be a deliberate edit, not an accident.
  for (const m of MODELS) {
    assert.equal(
      supportsVideoReference(m.name),
      supportsAudio(m.name),
      `${m.name} disagrees between supportsAudio and supportsVideoReference`
    );
  }
});

test("the reference-clip cap matches ModelArk's documented limit", () => {
  assert.equal(MAX_REFERENCE_VIDEOS, 3);
});
