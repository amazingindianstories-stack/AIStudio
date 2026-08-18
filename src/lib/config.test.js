import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULTS,
  DEPTH_ENCODERS,
  DEPTH_MODEL_NAME,
  MAX_REFERENCE_VIDEOS,
  MODELS,
  MODES,
  VIDEO_TASK_MODES,
  aspectRatiosForModel,
  durationsForModel,
  durationRangeForModel,
  isKlingImageModel,
  resolutionsForModel,
  supportsAudio,
  supportsSeed,
  supportsVideoBestOf,
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

// ── reproducibility seed gating (Phase 3.1) ─────────────────────────────────
//
// Only the two probe/docs-confirmed request-side seed fields (Gemini/NBP,
// native BytePlus Seedance) return true — everything else is an explicit
// "no evidence either way" exclusion, not a tested-and-rejected claim. Same
// higgsfield-before-seedance substring trap as supportsAudio: "Higgsfield
// Seedance 2.0" contains "seedance" too.

test("Nano Banana Pro supports seed", () => {
  assert.equal(supportsSeed("Nano Banana Pro"), true);
});

test("native BytePlus Seedance supports seed", () => {
  assert.equal(supportsSeed("Seedance 2.0"), true);
  assert.equal(supportsSeed("Seedance 2.0 Mini"), true);
});

test("Higgsfield Seedance does NOT get seed, despite containing 'seedance'", () => {
  assert.equal(supportsSeed("Higgsfield Seedance 2.0"), false);
  assert.equal(supportsSeed("Higgsfield Seedance 2.0 Mini"), false);
});

test("Omni and Kling are explicitly excluded (no probe evidence either way)", () => {
  assert.equal(supportsSeed("Gemini Omni Flash"), false);
  assert.equal(supportsSeed("Kling Image 3.0"), false);
  assert.equal(supportsSeed("Kling Image 2.1"), false);
});

test("Higgsfield Soul (image) is not seed-capable", () => {
  assert.equal(supportsSeed("Higgsfield Soul"), false);
});

test("seed matching is case-insensitive", () => {
  assert.equal(supportsSeed("nano banana pro"), true);
  assert.equal(supportsSeed("SEEDANCE 2.0"), true);
  assert.equal(supportsSeed("HIGGSFIELD SEEDANCE 2.0"), false);
});

test("every model in the picker resolves supportsSeed without throwing", () => {
  for (const m of MODELS) {
    assert.equal(typeof supportsSeed(m.name), "boolean", m.name);
  }
});

// ── video best-of-N + frame-judge gating (Phase 3.2) ────────────────────────
//
// Scoped narrower than supportsSeed: it's a submission-shape decision (submit
// N provider tasks in parallel), not a provider-capability claim, so only the
// one video path this phase actually extended (native BytePlus) is true.

test("native BytePlus Seedance supports video best-of-N", () => {
  assert.equal(supportsVideoBestOf("Seedance 2.0"), true);
  assert.equal(supportsVideoBestOf("Seedance 2.0 Mini"), true);
  assert.equal(supportsVideoBestOf("Seedance 2.5"), true);
});

test("Higgsfield Seedance does NOT get best-of-N, despite containing 'seedance'", () => {
  assert.equal(supportsVideoBestOf("Higgsfield Seedance 2.0"), false);
  assert.equal(supportsVideoBestOf("Higgsfield Seedance 2.0 Mini"), false);
});

test("Omni is excluded — it has its own separate submission path", () => {
  assert.equal(supportsVideoBestOf("Gemini Omni Flash"), false);
});

test("image models are not video-best-of-N capable", () => {
  assert.equal(supportsVideoBestOf("Nano Banana Pro"), false);
  assert.equal(supportsVideoBestOf("Kling Image 3.0"), false);
});

test("video best-of-N matching is case-insensitive", () => {
  assert.equal(supportsVideoBestOf("SEEDANCE 2.0"), true);
  assert.equal(supportsVideoBestOf("HIGGSFIELD SEEDANCE 2.0"), false);
});

test("every model in the picker resolves supportsVideoBestOf without throwing", () => {
  for (const m of MODELS) {
    assert.equal(typeof supportsVideoBestOf(m.name), "boolean", m.name);
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
  // Both models do 1K/2K with no reference attached; neither gets 4K (that is
  // the Omni model). 2.1 loses 2K only once a reference is attached — measured,
  // see the reference-conditional test below.
  assert.deepEqual(resolutionsForModel("Kling Image 3.0", "image"), ["1K", "2K"]);
  assert.deepEqual(resolutionsForModel("Kling Image 2.1", "image"), ["1K", "2K"]);
  // Unchanged for everything else.
  assert.ok(resolutionsForModel("Nano Banana Pro", "image").includes("4K"));
});

test("attaching a reference drops 2K for Kling 2.1 but not for 3.0", () => {
  // Four 2K text-to-image rows on 2.1 succeeded 2026-07-30 (refs=0); 2K with a
  // reference failed 2026-08-17 with `400 code 1201: resolution value '2k' is
  // not supported`. So this is about the reference, not the model.
  assert.deepEqual(resolutionsForModel("Kling Image 2.1", "image", true), ["1K"]);
  assert.deepEqual(resolutionsForModel("Kling Image 3.0", "image", true), ["1K", "2K"]);
  // Nothing else takes the flag into account.
  assert.deepEqual(
    resolutionsForModel("Nano Banana Pro", "image", true),
    resolutionsForModel("Nano Banana Pro", "image", false)
  );
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
  for (const kind of ["image", "video"] ) {
    const name = DEFAULTS[kind].model;
    const entry = MODELS.find((m) => m.name === name);
    assert.ok(entry, `DEFAULTS.${kind}.model "${name}" is not in MODELS`);
    assert.equal(entry.kind, kind, `DEFAULTS.${kind}.model "${name}" is not a ${kind} model`);
  }
});

// ── Depth-map worker ─────────────────────────────────────────────────────

test("depthDefaultIsOfferedModel: DEFAULTS.depth.model matches the one kind='depth' MODELS entry", () => {
  assert.equal(DEFAULTS.depth.model, DEPTH_MODEL_NAME);
  const entry = MODELS.find((m) => m.kind === "depth");
  assert.ok(entry, "no MODELS entry has kind='depth'");
  assert.equal(entry.name, DEPTH_MODEL_NAME);
  // Exactly one — a second depth entry would be ambiguous, since the
  // composer has no model picker for this mode to disambiguate with.
  assert.equal(MODELS.filter((m) => m.kind === "depth").length, 1);
});

test("MODES includes depth alongside image/video", () => {
  assert.ok(MODES.some((m) => m.id === "depth" && m.enabled));
});

test("DEPTH_ENCODERS: default (DEFAULTS.depth.resolution) is a valid encoder", () => {
  assert.ok(DEPTH_ENCODERS.includes(DEFAULTS.depth.resolution));
  assert.deepEqual(DEPTH_ENCODERS, ["vits", "vitb", "vitl"]);
});

// ── Seedance 2.5 ─────────────────────────────────────────────────────────

test("Seedance 2.5 is in the picker as a video model", () => {
  const entry = MODELS.find((m) => m.name === "Seedance 2.5");
  assert.ok(entry, "Seedance 2.5 is not in MODELS");
  assert.equal(entry.kind, "video");
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

test("durationRangeForModel gives Seedance 2.0/2.5 a continuous bounded range, not an enum", () => {
  assert.deepEqual(durationRangeForModel("Seedance 2.0"), { min: 4, max: 15, step: 1 });
  assert.deepEqual(durationRangeForModel("Seedance 2.5"), { min: 4, max: 30, step: 1 });
  assert.deepEqual(durationRangeForModel("Seedance 2.0 Mini"), { min: 4, max: 15, step: 1 });
});

test("durationRangeForModel is null for true-enum providers (Higgsfield/Omni)", () => {
  // The substring trap this codebase keeps hitting: Higgsfield model names
  // also contain "seedance", so a bare /seedance/i test would wrongly hand
  // it a continuous range its MCP doesn't support.
  assert.equal(durationRangeForModel("Higgsfield Seedance 2.0"), null);
  assert.equal(durationRangeForModel("Gemini Omni Flash"), null);
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
  for (const kind of ["image", "video"] ) {
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
