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
 *  offer 15s for them (it would be silently clamped — wasted/confusing). */
export function durationsForModel(model: string): number[] {
  if (/higgsfield/i.test(model)) return [3, 4, 5, 6, 8, 10, 12];
  return DURATIONS;
}

/** Valid resolutions per model. Seedance 2.0 Mini supports 480p/720p only
 *  (per its MCP schema — no 1080p/4k SKU on the mini). */
export function resolutionsForModel(model: string, kind: GenerationKind): string[] {
  if (/seedance.*mini/i.test(model)) return ["480p", "720p"];
  return RESOLUTIONS[kind];
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
