import type { GenerationKind } from "./types";

export interface ModelOption {
  id: string;
  name: string;
  kind: GenerationKind;
  badge?: string;
  /** Short cue shown under the name in the model picker. */
  hint?: string;
}

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
export const MODELS: ModelOption[] = [
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
    hint: "Cheapest text-to-image here (~$0.014) — takes a single reference image",
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
];

export interface ModeOption {
  id: GenerationKind | "chat" | "avatar" | "audio";
  label: string;
  icon: string; // lucide icon name handled in component
  enabled: boolean;
}

export const MODES: ModeOption[] = [
  { id: "image", label: "AI Image", icon: "Image", enabled: true },
  { id: "video", label: "AI Video", icon: "Clapperboard", enabled: true },
];

export const ASPECT_RATIOS: Record<GenerationKind, string[]> = {
  image: ["1:1", "3:4", "4:3", "9:16", "16:9", "21:9"],
  video: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
};

export const RESOLUTIONS: Record<GenerationKind, string[]> = {
  image: ["1K", "2K", "4K"],
  video: ["480p", "720p", "1080p"],
};

export const DURATIONS = [4, 5, 8, 10, 15]; // seconds (video)

/** History cursor-pagination page size (server default + client hasMore check). */
export const HISTORY_PAGE_SIZE = 20;

/** Valid durations per model. Higgsfield's Seedance/DoP cap at 12s, so don't
 *  offer 15s for them (it would be silently clamped — wasted/confusing).
 *  Omni's duration IS a real, enforced request field (response_format.duration,
 *  a protobuf-Duration string like "4s" — see providers/omni.ts header) —
 *  [4,6,8] here is just the UI's offered set. */
export function durationsForModel(model: string): number[] {
  if (/omni/i.test(model)) return [4, 6, 8];
  if (/higgsfield/i.test(model)) return [3, 4, 5, 6, 8, 10, 12];
  // 2.5 raised the cap from 15s to 30s (BytePlus's own "Latest capabilities"
  // changelog, docs.byteplus.com/en/docs/ModelArk/2607688, read 2026-08-07).
  if (/seedance 2\.5/i.test(model)) return [4, 5, 8, 10, 15, 20, 25, 30];
  return DURATIONS;
}

/** Valid resolutions per model. Seedance 2.0 Mini supports 480p/720p only
 *  (per its MCP schema — no 1080p/4k SKU on the mini). Omni doesn't accept a
 *  resolution request param (probe-confirmed) — "720p" is exposed as the
 *  single non-choice for UI consistency with other models' resolution
 *  picker; the provider ignores it. */
export function resolutionsForModel(model: string, kind: GenerationKind): string[] {
  if (/omni/i.test(model)) return ["720p"];
  if (/seedance.*mini/i.test(model)) return ["480p", "720p"];
  // 2.5 caps at 720p — no 1080p/4K SKU. BytePlus's own capability table says
  // so explicitly, contradicting a launch-tweet "up to 4K" claim (see
  // docs.byteplus.com/en/docs/ModelArk/2607688, read 2026-08-07).
  if (/seedance 2\.5/i.test(model)) return ["480p", "720p"];
  // Kling Image 3.0 / 2.1 are 1K/2K per Kling's capability map — 4K is the Omni
  // model only. Offering 4K here would produce a 2K image labelled 4K, or a
  // failed job; the provider rejects it either way, so don't offer it.
  if (isKlingImageModel(model)) return ["1K", "2K"];
  return RESOLUTIONS[kind];
}

/** Valid aspect ratios per model. Omni is probe-confirmed 16:9/9:16 only —
 *  everything else keeps today's full per-kind list. */
export function aspectRatiosForModel(model: string, kind: GenerationKind): string[] {
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
export function isKlingImageModel(model: string): boolean {
  return /^kling image/i.test(model.trim());
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
export function supportsVideoReference(model: string): boolean {
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
export function supportsAudio(model: string): boolean {
  if (/higgsfield/i.test(model)) return false;
  if (/omni/i.test(model)) return false;
  return /seedance/i.test(model);
}

/** The three task types Seedance 2.5's single endpoint supports, chosen by
 *  content role + prompt wording rather than a request field (see
 *  providers/seedance.ts createVideoTask). "generate" covers ordinary
 *  text/image/reference-to-video — the only mode every other model has. */
export type VideoTaskMode = "generate" | "edit" | "extend";
export const VIDEO_TASK_MODES: VideoTaskMode[] = ["generate", "edit", "extend"];

/**
 * Can this model Edit or Extend an attached reference clip, not just
 * generate from one? Seedance 2.5 only — 2.0 has no such task type, and
 * Edit/Extend both require BytePlus's ratio="adaptive"/duration constraints
 * (docs.byteplus.com/en/docs/ModelArk/2607688), which nothing else here
 * needs to enforce. Exact-name match rather than the bare /seedance/i this
 * file uses elsewhere, because — unlike audio/video-reference — this is NOT
 * a capability 2.0 also has.
 */
export function supportsVideoEditExtend(model: string): boolean {
  return /seedance 2\.5/i.test(model);
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
};
