import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULTS,
  MAX_REFERENCE_VIDEOS,
  MODELS,
  VIDEO_TASK_MODES,
  aspectRatiosForModel,
  durationsForModel,
  isKlingImageModel,
  resolutionsForModel,
  supportsAudio,
  supportsVideoEditExtend,
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

test("exactly the two native BytePlus models in the picker are audio-capable today", () => {
  // "Seedance 2.0" and "Seedance 2.5" (both BytePlus direct). The BytePlus
  // mini SKU exists in the provider (pickModel routes mini/fast to
  // SEEDANCE_MODEL_FAST) and has a pricing row, but it has never been added to
  // MODELS. If a native mini is ever added to the picker this assertion should
  // be updated, not deleted.
  const capable = MODELS.filter((m) => supportsAudio(m.name)).map((m) => m.name);
  assert.deepEqual(capable, ["Seedance 2.0", "Seedance 2.5"]);
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

// ── Kling image models ──────────────────────────────────────────────────────

test("Kling image models are in the picker and are image-kind", () => {
  const kling = MODELS.filter((m) => isKlingImageModel(m.name));
  assert.deepEqual(
    kling.map((m) => m.name),
    ["Kling Image 3.0", "Kling Image 2.1"]
  );
  for (const m of kling) assert.equal(m.kind, "image");
});

test("isKlingImageModel does not match other models", () => {
  for (const name of ["Nano Banana Pro", "Seedance 2.0", "Gemini Omni Flash"]) {
    assert.equal(isKlingImageModel(name), false, name);
  }
});

test("Kling gets neither audio nor a video reference", () => {
  // Both are video-only features; Kling here is images. The regexes must not
  // pick these up by accident.
  for (const m of MODELS.filter((m) => isKlingImageModel(m.name))) {
    assert.equal(supportsAudio(m.name), false, m.name);
    assert.equal(supportsVideoReference(m.name), false, m.name);
  }
});

test("Kling is offered 1K/2K only — 4K is the Omni model", () => {
  for (const name of ["Kling Image 3.0", "Kling Image 2.1"]) {
    assert.deepEqual(resolutionsForModel(name, "image"), ["1K", "2K"]);
  }
  // Unchanged for everything else.
  assert.ok(resolutionsForModel("Nano Banana Pro", "image").includes("4K"));
});

test("Kling exposes its own aspect-ratio set, including 3:2 and 2:3", () => {
  const ars = aspectRatiosForModel("Kling Image 3.0", "image");
  for (const ar of ["1:1", "3:4", "4:3", "9:16", "16:9", "3:2", "2:3", "21:9"]) {
    assert.ok(ars.includes(ar), `missing ${ar}`);
  }
});

test("Higgsfield is no longer offered in the picker", () => {
  // Removed from the UI on 2026-07-30 while the backend stays. If a Higgsfield
  // entry ever comes back this should be a deliberate edit.
  assert.equal(
    MODELS.some((m) => /higgsfield/i.test(m.name)),
    false
  );
});

test("every picker model has a unique id and name", () => {
  assert.equal(new Set(MODELS.map((m) => m.id)).size, MODELS.length);
  assert.equal(new Set(MODELS.map((m) => m.name)).size, MODELS.length);
});

test("defaultsAreOfferedModels: every DEFAULTS model is in the picker", () => {
  // The invariant that broke when Higgsfield was removed from MODELS while
  // DEFAULTS.video.model still named it: the composer then sat on a model the
  // picker could not display, and generations still routed to that provider.
  for (const kind of ["image", "video"] as const) {
    const name = DEFAULTS[kind].model;
    const entry = MODELS.find((m) => m.name === name);
    assert.ok(entry, `DEFAULTS.${kind}.model "${name}" is not in MODELS`);
    assert.equal(entry.kind, kind, `DEFAULTS.${kind}.model "${name}" is not a ${kind} model`);
  }
});

// ── Seedance 2.5 ─────────────────────────────────────────────────────────

test("Seedance 2.5 is in the picker as a video model", () => {
  const entry = MODELS.find((m) => m.name === "Seedance 2.5");
  assert.ok(entry, "Seedance 2.5 is not in MODELS");
  assert.equal(entry!.kind, "video");
});

test("Seedance 2.5 caps at 480p/720p — no 1080p/4K SKU", () => {
  assert.deepEqual(resolutionsForModel("Seedance 2.5", "video"), ["480p", "720p"]);
});

test("Seedance 2.0 keeps its own resolution set unaffected by the 2.5 branch", () => {
  assert.deepEqual(resolutionsForModel("Seedance 2.0", "video"), [
    "480p",
    "720p",
    "1080p",
  ]);
});

test("Seedance 2.5 allows durations up to 30s", () => {
  const durations = durationsForModel("Seedance 2.5");
  assert.equal(Math.max(...durations), 30);
  assert.equal(Math.min(...durations), 4);
});

test("Seedance 2.0 keeps its 15s cap unaffected by the 2.5 branch", () => {
  assert.equal(Math.max(...durationsForModel("Seedance 2.0")), 15);
});

test("only Seedance 2.5 supports Edit/Extend", () => {
  assert.equal(supportsVideoEditExtend("Seedance 2.5"), true);
  assert.equal(supportsVideoEditExtend("Seedance 2.0"), false);
  // The substring trap this codebase keeps hitting: Higgsfield names also
  // contain "seedance". supportsVideoEditExtend's exact-name match must not
  // fall for a hypothetical "Higgsfield Seedance 2.5" the way a bare
  // /seedance/i test would.
  assert.equal(supportsVideoEditExtend("Higgsfield Seedance 2.0"), false);
  assert.equal(supportsVideoEditExtend("Gemini Omni Flash"), false);
});

test("Seedance 2.5 is audio- and video-reference-capable like 2.0", () => {
  assert.equal(supportsAudio("Seedance 2.5"), true);
  assert.equal(supportsVideoReference("Seedance 2.5"), true);
});

test("VIDEO_TASK_MODES always starts with generate", () => {
  // The default every model that isn't Seedance 2.5 is permanently on.
  assert.equal(VIDEO_TASK_MODES[0], "generate");
  assert.deepEqual(VIDEO_TASK_MODES, ["generate", "edit", "extend"]);
});

test("each DEFAULTS combination is valid for its own model", () => {
  // A default aspect ratio / resolution / duration the model doesn't accept is
  // silently dropped by restoreComposerDraft, so catch it here instead.
  for (const kind of ["image", "video"] as const) {
    const d = DEFAULTS[kind];
    assert.ok(
      aspectRatiosForModel(d.model, kind).includes(d.aspectRatio),
      `${d.model} does not offer ${d.aspectRatio}`
    );
    assert.ok(
      resolutionsForModel(d.model, kind).includes(d.resolution),
      `${d.model} does not offer ${d.resolution}`
    );
  }
  assert.ok(
    durationsForModel(DEFAULTS.video.model).includes(DEFAULTS.video.duration),
    `${DEFAULTS.video.model} does not offer ${DEFAULTS.video.duration}s`
  );
});
