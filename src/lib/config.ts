import type { GenerationKind } from "./types";

export interface ModelOption {
  id: string;
  name: string;
  kind: GenerationKind;
  badge?: string;
  /** Short cue shown under the name in the model picker. */
  hint?: string;
}

export const MODELS: ModelOption[] = [
  { id: "nano-banana-pro", name: "Nano Banana Pro", kind: "image", badge: "BEST" },
  { id: "higgsfield-seedance", name: "Higgsfield Seedance 2.0", kind: "video", badge: "MULTI-REF" },
  // NOTE: Higgsfield's web "Mini Unlimited" / "Enhanced Fast Unlimited"
  // offers are web-UI-only features the MCP does not expose — API jobs on
  // seedance_2_0_mini bill normally (measured 2.5 credits/s at 720p).
  {
    id: "higgsfield-seedance-mini",
    name: "Higgsfield Seedance 2.0 Mini",
    kind: "video",
    badge: "BUDGET",
    hint: "Billed per second via API — Higgsfield's web Unlimited offer doesn't apply",
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
    hint: "BytePlus ModelArk direct — its filter rejects photorealistic faces; use Higgsfield for those",
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
  return RESOLUTIONS[kind];
}

/** Valid aspect ratios per model. Omni is probe-confirmed 16:9/9:16 only —
 *  everything else keeps today's full per-kind list. */
export function aspectRatiosForModel(model: string, kind: GenerationKind): string[] {
  if (/omni/i.test(model)) return ["16:9", "9:16"];
  return ASPECT_RATIOS[kind];
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

export const DEFAULTS = {
  image: {
    model: "Nano Banana Pro",
    aspectRatio: "1:1",
    resolution: "2K",
  },
  video: {
    model: "Higgsfield Seedance 2.0",
    aspectRatio: "16:9",
    resolution: "1080p",
    duration: 5,
  },
};
