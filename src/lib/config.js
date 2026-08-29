import {
  DEPTH_MODEL_NAME,
  capability,
  getModelDefinition,
  isProviderModel,
  offeredModels,
} from "./model-registry";

export { DEPTH_MODEL_NAME } from "./model-registry";
/**
 * Models offered in the picker.
 *
 * The two Higgsfield Seedance entries were removed from this list on 2026-07-30.
 * The hidden MCP compatibility path remains supported for historical retries
 * and readable history rows. Its pricing rows also remain historical evidence.
 * New dev-API credentials are not required for this compatibility path and are
 * intentionally retired. `isHiggsfieldModel` is still consulted by the routes
 * and must stay.
 */

/** Stamped on every depth-map generation row (generate/depth/route.js) and
 *  the one MODELS entry with kind="depth" below — see that entry's comment.
 *  Declared ahead of MODELS because the entry below references it. */
/** vits = fastest/lowest quality, vitb = balanced (default), vitl = slowest/
 *  highest quality — see Video-Depth-Anything's own README for the params
 *  each trades off (28M/113M/382M). vitl is sized for A100-class GPUs per
 *  that README's own benchmark table, so it's offered but not defaulted to
 *  on Apple Silicon. */
export const DEPTH_ENCODERS = ["vits", "vitb", "vitl"];

/** Human-readable label/hint for each encoder — shown in the composer's
 *  picker and reused wherever a finished depth row's `resolution` (which
 *  carries the encoder choice, see DEPTH_ENCODERS) needs to read as
 *  something friendlier than the raw "vitb" string, e.g. DetailModal. */
export const DEPTH_ENCODER_LABELS = {
  vits: { label: "Fast", hint: "Small model — quickest, lowest detail" },
  vitb: { label: "Balanced", hint: "Default — good detail at a reasonable speed" },
  vitl: { label: "Best", hint: "Large model — most detail, slowest (sized for a real GPU)" },
};

export const MODELS = offeredModels();

export const MODES = [
  { id: "image", label: "AI Image", icon: "Image", enabled: true },
  { id: "video", label: "AI Video", icon: "Clapperboard", enabled: true },
  { id: "depth", label: "Depth Map", icon: "Layers", enabled: true },
];

// depth: [] on both — the depth composer has no aspect-ratio or resolution
// picker (aspect ratio is measured from the output after the fact, same as
// Kling image-to-image; DEPTH_ENCODERS is the closest depth analogue to
// "resolution" and is a separate list, not folded in here). Present as empty
// rather than omitted so aspectRatiosForModel/resolutionsForModel and
// restoreComposerDraft's `.includes()` validation degrade to "nothing
// restored" instead of a TypeError on `undefined.includes`.
export const ASPECT_RATIOS = {
  image: ["1:1", "3:4", "4:3", "9:16", "16:9", "21:9"],
  video: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
  depth: [],
};

export const RESOLUTIONS = {
  image: ["1K", "2K", "4K"],
  video: ["480p", "720p", "1080p"],
  depth: [],
};

export const DURATIONS = [4, 5, 8, 10, 15]; // seconds (video)

/** History cursor-pagination page size (server default + client hasMore check). */
export const HISTORY_PAGE_SIZE = 20;

/** Valid durations per model. Higgsfield's Seedance/DoP cap at 12s, so don't
 *  offer 15s for them (it would be silently clamped — wasted/confusing).
 *  Omni's duration IS a real, enforced request field (response_format.duration,
 *  a protobuf-Duration string like "4s" — see providers/omni.js header) —
 *  [4,6,8] here is just the UI's offered set. */
export function durationsForModel(model) {
  return capability(model, "durations", DURATIONS);
}

/** Native BytePlus Seedance (2.0 and 2.5) accepts any *integer* duration
 *  within its documented bounds, not a fixed enum — `providers/seedance.js`
 *  passes `input.duration` straight through as `body.duration` with no
 *  membership check. Higgsfield's MCP and Omni's Interactions API are true
 *  enums (see the file-header comments on those providers), so this only
 *  ever applies to the two direct-BytePlus models; everything else stays on
 *  `durationsForModel`'s discrete list and the composer's Segment control.
 *  Bounds: BytePlus's own docs (docs.byteplus.com/en/docs/ModelArk/2607688,
 *  read 2026-08-17) — 2.0 is 4-15s, 2.5's raised cap is 4-30s. */
export function durationRangeForModel(model) {
  return capability(model, "durationRange", null);
}

/** Valid resolutions per model. Seedance 2.0 Mini supports 480p/720p only
 *  (per its MCP schema — no 1080p/4k SKU on the mini). Omni doesn't accept a
 *  resolution request param (probe-confirmed) — "720p" is exposed as the
 *  single non-choice for UI consistency with other models' resolution
 *  picker; the provider ignores it. */
export function resolutionsForModel(model, kind, hasReference = false) {
  const definition = getModelDefinition(model);
  if (hasReference && definition?.capabilities?.referenceResolutions) {
    return definition.capabilities.referenceResolutions;
  }
  return definition?.capabilities?.resolutions ?? RESOLUTIONS[kind];
}

/** Valid aspect ratios per model. Omni is probe-confirmed 16:9/9:16 only —
 *  everything else keeps today's full per-kind list. */
export function aspectRatiosForModel(model, kind) {
  return capability(model, "aspectRatios", ASPECT_RATIOS[kind]);
}

/**
 * Kling image models. Resolved through browser-safe registry metadata rather
 * than importing providers/kling.js, which pulls in `sharp`.
 */
export function isKlingImageModel(model) {
  return isProviderModel(model, "kling");
}

/**
 * Which Kling image models accept `resolution: "2k"` *together with a reference
 * image*. Only 3.0 does — 2.1 does 2K in text-to-image only; see
 * resolutionsForModel above for the measurement. Deliberately matches on the
 * Explicit registry capability: future models must declare support rather than
 * accidentally inheriting it from a similar display name.
 */
export function isKling2KModel(model) {
  return capability(model, "referenceResolutions", []).includes("2K");
}

/** Most references Kling's /v1/images/generations will take. Its `image` field
 *  is a scalar; multi-reference is a different endpoint and model entirely. */
export const KLING_MAX_REFERENCE_IMAGES = 1;

/**
 * BytePlus ModelArk multimodal-reference limits. These are API limits, not
 * limits inferred from the Dreamina consumer UI: the official enhanced video
 * generation reference documents 1–9 images for Seedance 2.0 series and
 * 1–30 for Seedance 2.5 series.
 * https://docs.byteplus.com/en/docs/byteplus_las/video_gen_enhanced
 */
export const SEEDANCE_20_MAX_REFERENCE_IMAGES = 9;
export const SEEDANCE_25_MAX_REFERENCE_IMAGES = 30;

/** Maximum reference images accepted by a Seedance video model, or null when
 * this capability is governed by another provider-specific adapter. */
export function maxReferenceImagesForVideoModel(model) {
  return capability(model, "maxReferenceImages", null);
}

/**
 * Can this model take an existing CLIP as a reference (video-to-video)?
 *
 * Probe-verified against BytePlus ModelArk on 2026-07-29: the native Seedance
 * path accepts `reference_video` content items. Higgsfield's MCP exposes no
 * video-reference parameter and Omni's Interactions request has none either,
 * so the same higgsfield-before-seedance ordering as supportsAudio applies —
 * the Higgsfield model names also contain "seedance".
 */
export function supportsVideoReference(model) {
  return capability(model, "videoReference", false);
}

/** ModelArk accepts at most 3 reference clips per request. */
export const MAX_REFERENCE_VIDEOS = 3;

/**
 * Can this model generate an audio track with the video?
 *
 * Only the native BytePlus ModelArk path. `generate_audio` is a top-level
 * boolean on ModelArk's create-task payload (see providers/seedance.js), and it
 * is the *only* one of our video paths that has such a field: Higgsfield's MCP
 * exposes no audio parameter on its Seedance tools, and Omni's Interactions
 * request has no audio field either. Matching "higgsfield" first matters —
 * "Higgsfield Seedance 2.0" also contains "seedance", and offering an audio
 * toggle there would be a control that silently does nothing.
 */
export function supportsAudio(model) {
  return capability(model, "audio", false);
}

/** The three task types Seedance 2.5's single endpoint supports, chosen by
 *  content role + prompt wording rather than a request field (see
 *  providers/seedance.js createVideoTask). "generate" covers ordinary
 *  text/image/reference-to-video — the only mode every other model has. */
 
export const VIDEO_TASK_MODES = ["generate", "edit", "extend"];

/**
 * Can this model Edit or Extend an attached reference clip, not just
 * generate from one? Seedance 2.5 only — 2.0 has no such task type, and
 * Edit/Extend both require BytePlus's ratio="adaptive"/duration constraints
 * (docs.byteplus.com/en/docs/ModelArk/2607688), which nothing else here
 * needs to enforce. This is explicit registry metadata because — unlike
 * audio/video-reference — it is NOT a capability 2.0 also has.
 */
export function supportsVideoEditExtend(model) {
  return capability(model, "editExtend", false);
}

/**
 * Can this model take a request-level reproducibility `seed` we've actually
 * confirmed (Phase 3.1)? Deliberately narrower than "every provider probably
 * has one somewhere":
 * - Gemini/Nano Banana Pro: `generationConfig.seed` is a real, documented
 *   GenerationConfig field (confirmed via Google's own docs/forums, 2026-08).
 *   Google's own developer forum reports it does NOT reliably guarantee
 *   determinism on every model — treat it as "nudges toward similar output",
 *   not a promise — but it is a real, accepted field, safe to send.
 * - Native BytePlus Seedance: `seed` is a documented ModelArk request field
 *   (confirmed via a live docs read, 2026-08-17 — see the ModelArk console
 *   docs page linked in providers/seedance.js).
 * - Kling: UNCONFIRMED. Kling's own docs page is client-rendered and answers
 *   plain fetchers with an empty shell (same issue as every other Kling doc
 *   check in this codebase — needs Claude-in-Chrome or a live probe). A
 *   third-party aggregator's schema for this exact model does NOT list a
 *   request-side seed field, which is grounds for caution, not confidence
 *   either way. `scripts/probe-kling-seed.js` verifies this for free
 *   (invalid-parameter trick, no task created) — run it before flipping this.
 * - Omni (Gemini Interactions API): explicitly NOT included. providers/omni.js's
 *   own header documents a narrow, probe-verified request body
 *   (`{model, input, background, response_format}`) and states unknown
 *   top-level parameters 400 the whole request — there is no probe evidence
 *   `seed` is one of the accepted ones, and guessing wrong breaks every Omni
 *   video generation, not just seed reproducibility.
 * - Higgsfield MCP: not included for the same reason as Kling/Omni — no
 *   catalog or probe evidence either way, and Higgsfield is already out of
 *   the model picker (2026-07-30) so there's no live path to verify against
 *   without re-enabling it.
 */
export function supportsSeed(model) {
  return capability(model, "seed", false);
}

/**
 * Video best-of-N + frame-judge scoring (Phase 3.2). Native BytePlus
 * Seedance only, same higgsfield-before-seedance ordering supportsAudio/
 * supportsSeed use ("Higgsfield Seedance 2.0" also contains "seedance") —
 * this is a submission-shape decision (queue/execute submits N
 * createVideoTask calls in parallel), not a provider-capability one, so it
 * is scoped to the one video path this phase actually extended. Omni and
 * Higgsfield have their own separate submission flows in submitVideo() that
 * were not touched.
 *
 * Distinct from — and additionally gated behind — the VIDEO_BEST_OF env var
 * itself (default unset = off): even on a supported model, this feature
 * needs a real ffmpeg binary bundled into the serverless function to judge
 * candidates (see video-frame-server.js's header for the unverified-on-
 * Vercel risk that gate exists to contain). Callers should check
 * `supportsVideoBestOf(model) && process.env.VIDEO_BEST_OF`, not this
 * function alone.
 */
export function supportsVideoBestOf(model) {
  return capability(model, "videoBestOf", false);
}

/**
 * Multi-shot chaining / "Continue this shot" (Phase 3.3) — can this model
 * take a `first_frame` starting-frame image? Native BytePlus Seedance only,
 * same higgsfield-before-seedance ordering as every other gate in this file.
 *
 * Weaker evidence than every other gate here: `role: "first_frame"` is not
 * confirmed against BytePlus's own docs (client-rendered SPA, unreachable
 * this session) or a live probe against this app's key — it comes from a
 * detailed third-party tutorial with real executed code and results (see
 * providers/seedance.js's identical note on createVideoTask). Run
 * scripts/probe-seedance-first-frame.js (real, billed generation — no free
 * validation trick exists for this field) before leaning on this in
 * production beyond what's already shipped.
 */
export function supportsFirstFrameContinuation(model) {
  return capability(model, "firstFrameContinuation", false);
}

export const DEFAULTS = {
  image: {
    model: "Nano Banana Pro",
    aspectRatio: "1:1",
    resolution: "2K",
  },
  video: {
    // Was "Higgsfield Seedance 2.0" until Higgsfield left the picker on
    // 2026-07-30. A default has to be a model that is actually IN `MODELS`:
    // restoreComposerDraft validates the persisted model against the list and
    // falls back here, so a default that isn't in the list leaves the composer
    // on a model the picker cannot show — and still routes to that provider.
    // `defaultsAreOfferedModels` in config.test.js pins this.
    model: "Seedance 2.0",
    aspectRatio: "16:9",
    resolution: "1080p",
    duration: 5,
  },
  depth: {
    model: DEPTH_MODEL_NAME,
    // Placeholders — corrected/ignored the same way described on ASPECT_RATIOS
    // and RESOLUTIONS above. Present so setMode's generic `DEFAULTS[mode]`
    // lookup never has to special-case depth to avoid reading undefined
    // fields off this object.
    aspectRatio: "16:9",
    resolution: DEPTH_ENCODERS[1], // "vitb" — see DEPTH_ENCODERS
  },
};
