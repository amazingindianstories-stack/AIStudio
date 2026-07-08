import type { GenerationKind } from "./types";

export interface ModelOption {
  id: string;
  name: string;
  kind: GenerationKind;
  badge?: string;
}

export const MODELS: ModelOption[] = [
  { id: "nano-banana-pro", name: "Nano Banana Pro", kind: "image", badge: "BEST" },
  { id: "higgsfield-nano-banana-pro", name: "Higgsfield Nano Banana Pro", kind: "image", badge: "TEST" },
  { id: "higgsfield-seedance", name: "Higgsfield Seedance 2.0", kind: "video", badge: "MULTI-REF" },
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

/** Valid durations per model. Higgsfield's Seedance/DoP cap at 12s, so don't
 *  offer 15s for them (it would be silently clamped — wasted/confusing). */
export function durationsForModel(model: string): number[] {
  if (/higgsfield/i.test(model)) return [3, 4, 5, 6, 8, 10, 12];
  return DURATIONS;
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
