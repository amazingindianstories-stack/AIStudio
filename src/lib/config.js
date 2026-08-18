

/**
 * Models offered in the picker.
 *
 * The two Higgsfield Seedance entries were removed from this list on 2026-07-30
 * — Higgsfield is being retired. Only the *picker* entries are gone: the MCP
 * provider (`providers/higgsfield-mcp.ts`), its pricing rows, its admin token
 * card and its status check all remain, so historical generations still render
 * with their model name and nothing 404s. Removing this list entry is what makes
 * the path unreachable from the UI; deleting the backend is a separate step.
 * `isHiggsfieldModel` is still consulted by the routes and must stay.
 */

/** Stamped on every depth-map generation row (generate/depth/route.js) and
 *  the one MODELS entry with kind="depth" below — see that entry's comment.
 *  Declared ahead of MODELS because the entry below references it. */
export const DEPTH_MODEL_NAME = "Depth Anything (Local)";

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

export const MODELS = [
  { id: "nano-banana-pro", name: "Nano Banana Pro", kind: "image", badge: "BEST" },
  // Kling image models (providers/kling.ts). Both run through Kling's
  // /v1/images/generations, which takes at most ONE reference image — the
  // multi-reference Omni endpoint is a separate model and is not wired up, so
  // the hints say so rather than letting a multi-@tag prompt fail unexplained.
  {
    id: "kling-image-3",
    name: "Kling Image 3.0",
    kind: "image",
    badge: "NEW",
    hint: "Strong prompt adherence, 1K/2K — takes a single reference image",
  },
  {
    id: "kling-image-21",
    name: "Kling Image 2.1",
    kind: "image",
    badge: "BUDGET",
    hint: "Cheapest text-to-image here (~$0.014) — 2K only without a reference",
  },
  // Native BytePlus ModelArk Seedance 2.0 (providers/seedance.ts), i.e. the
  // model direct from its vendor rather than resold through Higgsfield. The
  // provider and its pricing rows were always here; only the picker entry was
  // missing, which made the whole path unreachable from the UI.
  // The name must stay exactly "Seedance 2.0" — pricing rows are keyed on the
  // display name, and providers/seedance.ts `pickModel` routes anything
  // matching mini/fast/lite to the fast SKU instead of the standard one.
  {
    id: "seedance",
    name: "Seedance 2.0",
    kind: "video",
    badge: "DIRECT",
    // The hint used to end "...use Higgsfield for those", which became wrong
    // advice the moment Higgsfield left the picker on 2026-07-30. The limitation
    // is real and worth stating; pointing at an option the user can no longer
    // select is not.
    hint: "BytePlus ModelArk direct — its content filter rejects photorealistic faces",
  },
  // Native BytePlus ModelArk Seedance 2.5 — same async task API as 2.0
  // (providers/seedance.ts createVideoTask/getVideoTask), a different model
  // id, tighter resolution cap (480p/720p, no 1080p), a longer duration cap
  // (30s vs 15s), and two extra task types (Edit / Extend an attached clip —
  // see supportsVideoEditExtend). The name must stay exactly "Seedance 2.5"
  // — pricing rows and providers/seedance.ts's pickModel key on it, same as
  // "Seedance 2.0" above. Not yet activated on the account's API key as of
  // 2026-08-07; wired up ahead of that so it's ready the moment it is.
  {
    id: "seedance-25",
    name: "Seedance 2.5",
    kind: "video",
    badge: "NEW",
    hint: "BytePlus ModelArk direct — 480p/720p, up to 30s; can edit or extend an attached clip",
  },
  {
    id: "gemini-omni-flash",
    name: "Gemini Omni Flash",
    kind: "video",
    badge: "NEW",
    hint: "Google Interactions API — full NBP-style reference scaffolding, 16:9/9:16 only",
  },
  // The only "depth" entry, and the only model in this list that runs on
  // hardware this app doesn't pay cloud rates for — see the backend/ Depth
  // section in CLAUDE.md. Its composer is a different shape from image/video
  // (no prompt, no @tags, a video upload instead) so it isn't offered
  // through the normal model picker; DEPTH_MODEL_NAME above is what the
  // enqueue route stamps on every depth row, kept in sync with this entry's
  // `name` by depthDefaultIsOfferedModel in config.test.js the same way
  // defaultsAreOfferedModels already pins image/video.
  {
    id: "depth-anything-local",
    name: DEPTH_MODEL_NAME,
    kind: "depth",
    badge: "LOCAL",
    hint: "Runs on a local worker machine, not the cloud — offline if nobody's machine is running it",
  },
];

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
 *  a protobuf-Duration string like "4s" — see providers/omni.ts header) —
 *  [4,6,8] here is just the UI's offered set. */
export function durationsForModel(model) {
  if (/omni/i.test(model)) return [4, 6, 8];
  if (/higgsfield/i.test(model)) return [3, 4, 5, 6, 8, 10, 12];
  // 2.5 raised the cap from 15s to 30s (BytePlus's own "Latest capabilities"
  // changelog, docs.byteplus.com/en/docs/ModelArk/2607688, read 2026-08-07).
  if (/seedance 2\.5/i.test(model)) return [4, 5, 8, 10, 15, 20, 25, 30];
  return DURATIONS;
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
  if (/higgsfield/i.test(model) || /omni/i.test(model)) return null;
  if (/seedance 2\.5/i.test(model)) return { min: 4, max: 30, step: 1 };
  if (/seedance/i.test(model)) return { min: 4, max: 15, step: 1 };
  return null;
}

/** Valid resolutions per model. Seedance 2.0 Mini supports 480p/720p only
 *  (per its MCP schema — no 1080p/4k SKU on the mini). Omni doesn't accept a
 *  resolution request param (probe-confirmed) — "720p" is exposed as the
 *  single non-choice for UI consistency with other models' resolution
 *  picker; the provider ignores it. */
export function resolutionsForModel(model, kind, hasReference = false) {
  if (/omni/i.test(model)) return ["720p"];
  if (/seedance.*mini/i.test(model)) return ["480p", "720p"];
  // 2.5 caps at 720p — no 1080p/4K SKU. BytePlus's own capability table says
  // so explicitly, contradicting a launch-tweet "up to 4K" claim (see
  // docs.byteplus.com/en/docs/ModelArk/2607688, read 2026-08-07).
  if (/seedance 2\.5/i.test(model)) return ["480p", "720p"];
  // 4K is the Omni model only for both Kling images. Offering it here would
  // produce a 2K image labelled 4K, or a failed job; the provider rejects it
  // either way, so don't offer it.
  //
  // Kling Image 2.1 does 2K, but ONLY without a reference image — measured
  // from our own history, not read: four 2K text-to-image rows succeeded on
  // 2026-07-30 (refs=0), while 2K *with* a reference returned
  // `http 400, code 1201: resolution value '2k' is not supported` on
  // 2026-08-17. `hasReference` is therefore part of the answer here; when it
  // is unknown the full list is returned, and providers/kling.js still refuses
  // the combination, so a missed call site degrades to a clear pre-spend error
  // rather than a wasted round-trip.
  if (isKlingImageModel(model)) {
    return hasReference && !isKling2KModel(model) ? ["1K"] : ["1K", "2K"];
  }
  return RESOLUTIONS[kind];
}

/** Valid aspect ratios per model. Omni is probe-confirmed 16:9/9:16 only —
 *  everything else keeps today's full per-kind list. */
export function aspectRatiosForModel(model, kind) {
  if (/omni/i.test(model)) return ["16:9", "9:16"];
  // Kling supports two ratios this app's image list doesn't offer (3:2, 2:3),
  // so intersecting would silently lose them; list Kling's own set.
  if (isKlingImageModel(model)) {
    return ["1:1", "3:4", "4:3", "9:16", "16:9", "3:2", "2:3", "21:9"];
  }
  return ASPECT_RATIOS[kind];
}

/**
 * Kling image models. Kept as a name test here (rather than importing
 * providers/kling.ts) because this module is imported by client components and
 * the provider pulls in `sharp`, which cannot be bundled for the browser.
 */
export function isKlingImageModel(model) {
  return /^kling image/i.test(model.trim());
}

/**
 * Which Kling image models accept `resolution: "2k"` *together with a reference
 * image*. Only 3.0 does — 2.1 does 2K in text-to-image only; see
 * resolutionsForModel above for the measurement. Deliberately matches on the
 * major version rather than the exact display name, so a future "Kling Image
 * 3.x" inherits the capability rather than being silently downgraded by a name
 * that no longer matches.
 */
export function isKling2KModel(model) {
  return /^kling image 3\b/i.test(model.trim());
}

/** Most references Kling's /v1/images/generations will take. Its `image` field
 *  is a scalar; multi-reference is a different endpoint and model entirely. */
export const KLING_MAX_REFERENCE_IMAGES = 1;

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
  if (/higgsfield/i.test(model)) return false;
  if (/omni/i.test(model)) return false;
  return /seedance/i.test(model);
}

/** ModelArk accepts at most 3 reference clips per request. */
export const MAX_REFERENCE_VIDEOS = 3;

/**
 * Can this model generate an audio track with the video?
 *
 * Only the native BytePlus ModelArk path. `generate_audio` is a top-level
 * boolean on ModelArk's create-task payload (see providers/seedance.ts), and it
 * is the *only* one of our video paths that has such a field: Higgsfield's MCP
 * exposes no audio parameter on its Seedance tools, and Omni's Interactions
 * request has no audio field either. Matching "higgsfield" first matters —
 * "Higgsfield Seedance 2.0" also contains "seedance", and offering an audio
 * toggle there would be a control that silently does nothing.
 */
export function supportsAudio(model) {
  if (/higgsfield/i.test(model)) return false;
  if (/omni/i.test(model)) return false;
  return /seedance/i.test(model);
}

/** The three task types Seedance 2.5's single endpoint supports, chosen by
 *  content role + prompt wording rather than a request field (see
 *  providers/seedance.ts createVideoTask). "generate" covers ordinary
 *  text/image/reference-to-video — the only mode every other model has. */
 
export const VIDEO_TASK_MODES = ["generate", "edit", "extend"];

/**
 * Can this model Edit or Extend an attached reference clip, not just
 * generate from one? Seedance 2.5 only — 2.0 has no such task type, and
 * Edit/Extend both require BytePlus's ratio="adaptive"/duration constraints
 * (docs.byteplus.com/en/docs/ModelArk/2607688), which nothing else here
 * needs to enforce. Exact-name match rather than the bare /seedance/i this
 * file uses elsewhere, because — unlike audio/video-reference — this is NOT
 * a capability 2.0 also has.
 */
export function supportsVideoEditExtend(model) {
  return /seedance 2\.5/i.test(model);
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
 *   docs page linked in providers/seedance.ts).
 * - Kling: UNCONFIRMED. Kling's own docs page is client-rendered and answers
 *   plain fetchers with an empty shell (same issue as every other Kling doc
 *   check in this codebase — needs Claude-in-Chrome or a live probe). A
 *   third-party aggregator's schema for this exact model does NOT list a
 *   request-side seed field, which is grounds for caution, not confidence
 *   either way. `scripts/probe-kling-seed.js` verifies this for free
 *   (invalid-parameter trick, no task created) — run it before flipping this.
 * - Omni (Gemini Interactions API): explicitly NOT included. providers/omni.ts's
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
  if (/nano banana/i.test(model)) return true;
  if (/higgsfield|omni|kling/i.test(model)) return false;
  return /seedance/i.test(model);
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
  if (/higgsfield|omni/i.test(model)) return false;
  return /seedance/i.test(model);
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
    // `defaultsAreOfferedModels` in config.test.ts pins this.
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
