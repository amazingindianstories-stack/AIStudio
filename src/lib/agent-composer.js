/**
 * The Agents chat composer's context, sent with each message as `composer` (backend/apps/agents/composer.py): the
 * mode tab (Image, Video or Upscale), its model and settings, the upscale source, and the project and folder new work
 * lands in. The run shows it to the model, so its calls follow the artist's choices, and the conversation's default
 * location follows it.
 *
 *   body.composer = composerContext(useStore.getState());
 */

import { supportsAudio, supportsBitrateMode, supportsDraftMode, supportsVideoEditExtend } from "./config";
import { capability } from "./model-registry";
import { MAGNIFIC_VIDEO_DEFAULTS, magnificParamsForModel, magnificVideoParamsForModel } from "./magnific-ui";
import { UNSORTED } from "./feed-scope";

/** The chat's mode tabs, as the store's `mode`. */
export const CHAT_MODES = ["image", "video", "upscale"];
export const IMAGE_UPSCALE_DEFAULT = "Magnific Creative";

function defined(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null));
}

/** The upscale tab's media, model, parameters (as the upscale tool takes them) and stored source URL, if any. */
export function upscaleChoice(s) {
  const media = s.upscalerMedia === "video" ? "video" : "image";
  const params = (media === "video" ? s.videoUpscalerParams : s.upscalerParams) || {};
  const model = params.model || (media === "video" ? MAGNIFIC_VIDEO_DEFAULTS.model : IMAGE_UPSCALE_DEFAULT);
  // The agent's upscale tool takes no NSFW filter switch, and the model is named on its own.
  const { model: _model, filterNsfw: _filter, ...chosen } = media === "video"
    ? magnificVideoParamsForModel(model, params) : magnificParamsForModel(model, params);
  const source = media === "video" ? s.upscalerVideo : s.upscalerImage;
  const url = typeof source === "string" ? source : source?.url;
  return { media, model, params: defined(chosen), source: url && !url.startsWith("data:") ? url : null };
}

/** The settings the Image or Video tab passes on, by the generate tool's argument names. */
export function generationOptions(s) {
  if (s.mode === "image") {
    return defined({ aspectRatio: s.aspectRatio, resolution: s.resolution, count: Math.min(4, Math.max(1, s.batchCount || 1)) });
  }
  const task = supportsVideoEditExtend(s.model) && ["edit", "extend"].includes(s.videoTaskMode) ? s.videoTaskMode : "generate";
  const fixedLength = capability(s.model, "inputDrivenVideo") || task === "edit";
  return defined({
    aspectRatio: task === "generate" ? s.aspectRatio : "adaptive",
    resolution: s.resolution,
    durationSeconds: !fixedLength && Number.isInteger(s.duration) ? s.duration : undefined,
    generateAudio: supportsAudio(s.model) && !capability(s.model, "inputDrivenVideo") ? Boolean(s.generateAudio) : undefined,
    draft: supportsDraftMode(s.model) ? Boolean(s.draftMode) : undefined,
    bitrateMode: supportsBitrateMode(s.model) && ["standard", "high"].includes(s.bitrateMode) ? s.bitrateMode : undefined,
    mode: supportsVideoEditExtend(s.model) ? task : undefined,
  });
}

/** The `composer` body field for a message sent from the current composer, or null outside the chat's modes. */
export function composerContext(s) {
  if (!CHAT_MODES.includes(s.mode)) return null;
  const location = defined({
    projectId: s.activeProjectId || undefined,
    folderId: s.activeFolderId && s.activeFolderId !== UNSORTED ? s.activeFolderId : undefined,
  });
  if (s.mode === "upscale") {
    const { media, model, params, source } = upscaleChoice(s);
    return { mode: "upscale", model, upscale: { media, params, ...(source ? { source } : {}) }, ...location };
  }
  return { mode: s.mode, model: s.model, options: generationOptions(s), ...location };
}

const MODE_LABELS = { image: "Image", video: "Video", upscale: "Upscale" };

/** The short tag a sent message shows for the composer it came from: "Video · Seedance 2.5". */
export function composerTag(composer) {
  if (!composer || !MODE_LABELS[composer.mode]) return null;
  const media = composer.media || composer.upscale?.media;
  const mode = composer.mode === "upscale" && media ? `Upscale ${media}` : MODE_LABELS[composer.mode];
  const model = composer.modelName || composer.model;
  return model ? `${mode} · ${model}` : mode;
}
