import { isProviderModel, capability } from "./model-registry";
import {
  maxReferenceImagesForVideoModel,
  supportsVideoReference,
  maxReferenceVideosForVideoModel,
  MAX_REFERENCE_VIDEOS,
  KLING_MAX_REFERENCE_IMAGES,
} from "./config";

/**
 * Validates whether a dragged generation item can be added as a reference
 * to the composer given the current mode, model, and already attached references.
 *
 * @param {Object} item - The dragged generation item
 * @param {Object} context - { mode, model, referenceImages, referenceVideos }
 * @returns {{ valid: boolean, reason?: string, action: 'add-image-ref' | 'add-video-ref' | 'none' }}
 */
export function validateGenerationReference(item, {
  mode = "image",
  model = "Nano Banana Pro",
  referenceImages = [],
  referenceVideos = [],
} = {}) {
  if (!item) {
    return { valid: false, reason: "No generation selected.", action: "none" };
  }

  if (item.status && item.status !== "succeeded") {
    return {
      valid: false,
      reason: item.status === "failed"
        ? "Failed generations cannot be used as references."
        : "This generation is still processing. Please wait for it to complete.",
      action: "none",
    };
  }

  if (!item.url) {
    return { valid: false, reason: "This generation has no media URL.", action: "none" };
  }

  if (mode === "depth") {
    return {
      valid: false,
      reason: "Depth Map mode only accepts direct video uploads.",
      action: "none",
    };
  }

  if (mode === "upscale") {
    if (item.kind !== "image") {
      return {
        valid: false,
        reason: "Upscaler only accepts image generations.",
        action: "none",
      };
    }
    return {
      valid: true,
      action: "add-image-ref",
    };
  }

  // 1. Dragged generation is an IMAGE
  if (item.kind === "image") {
    if (mode === "image") {
      const isSeedream = isProviderModel(model, "seedream");
      const isKling = isProviderModel(model, "kling");
      const maxAllowed = isSeedream
        ? 10
        : isKling
        ? (capability(model, "maxReferenceImages", KLING_MAX_REFERENCE_IMAGES) ?? KLING_MAX_REFERENCE_IMAGES)
        : (capability(model, "maxReferenceImages", 14) ?? 14);

      if (referenceImages.length >= maxAllowed) {
        return {
          valid: false,
          reason: `${model} accepts at most ${maxAllowed} reference image${maxAllowed === 1 ? "" : "s"}.`,
          action: "none",
        };
      }

      if (referenceImages.includes(item.url)) {
        return {
          valid: false,
          reason: "This reference image is already added.",
          action: "none",
        };
      }

      return { valid: true, action: "add-image-ref" };
    }

    if (mode === "video") {
      const maxAllowed = maxReferenceImagesForVideoModel(model) ?? 9;
      if (referenceImages.length >= maxAllowed) {
        return {
          valid: false,
          reason: `${model} accepts at most ${maxAllowed} reference images.`,
          action: "none",
        };
      }

      if (referenceImages.includes(item.url)) {
        return {
          valid: false,
          reason: "This reference image is already added.",
          action: "none",
        };
      }

      return { valid: true, action: "add-image-ref" };
    }
  }

  // 2. Dragged generation is a VIDEO
  if (item.kind === "video") {
    if (mode === "image") {
      return {
        valid: false,
        reason: `${model} is an image model and does not accept video references. Switch to AI Video, or open this video to use a still frame.`,
        action: "none",
      };
    }

    if (mode === "video") {
      if (!supportsVideoReference(model)) {
        return {
          valid: false,
          reason: `${model} does not support video references. Switch to Seedance 2.0 or 2.5 to use video-to-video references.`,
          action: "none",
        };
      }

      const maxVideos = maxReferenceVideosForVideoModel(model) ?? MAX_REFERENCE_VIDEOS;
      if (referenceVideos.length >= maxVideos) {
        return {
          valid: false,
          reason: `${model} accepts at most ${maxVideos} reference clip${maxVideos === 1 ? "" : "s"}.`,
          action: "none",
        };
      }

      if (referenceVideos.includes(item.url)) {
        return {
          valid: false,
          reason: "This video clip is already added as a reference.",
          action: "none",
        };
      }

      return { valid: true, action: "add-video-ref" };
    }
  }

  return { valid: false, reason: "Unsupported generation type.", action: "none" };
}
