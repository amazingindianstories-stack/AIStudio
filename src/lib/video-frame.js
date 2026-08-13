"use client";

import { REF_BUDGET_STEPS, dataUrlBytes } from "./client-image-budget";

/**
 * Pull a still frame out of a video, in the browser.
 *
 * This is the workaround that makes "video → image" real without depending on
 * any provider accepting video input, and it is deliberately client-side:
 *
 *  - Vercel caps request bodies at 4.5MB. A video cannot be uploaded through
 *    the existing reference path at all; a decoded frame is a small JPEG that
 *    fits the ladder every other reference already goes through.
 *  - Decoding server-side would need ffmpeg, which is not a dependency and is
 *    not present on the Vercel runtime.
 *  - `<video>` + `<canvas>` is already in every browser, costs nothing, and
 *    works for every model we have — the frame is just an image reference, so
 *    it flows into Nano Banana Pro, Soul, Seedance and Omni unchanged.
 *
 * Same-origin only in practice, which is fine: provider results are always
 * re-downloaded and re-served from `/api/media/...`, so drawing them to a
 * canvas does not taint it. A cross-origin video would throw on `toDataURL`,
 * and that is reported rather than swallowed.
 */

/** Wait for a media event, or reject if the element errors first. */
function once(el, event, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      el.removeEventListener(event, onOk);
      el.removeEventListener("error", onErr);
      clearTimeout(timer);
    };
    const onOk = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new Error("The browser could not decode this video."));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out reading the video."));
    }, timeoutMs);
    el.addEventListener(event, onOk, { once: true });
    el.addEventListener("error", onErr, { once: true });
  });
}

/**
 * Load a video and seek it, returning the element plus an explicit disposer.
 * The caller owns cleanup because a frame picker keeps the element alive across
 * many seeks rather than reloading per frame.
 */
export async function loadVideo(src)

 {
  const objectUrl = typeof src === "string" ? null : URL.createObjectURL(src);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  // Only meaningful for remote sources; harmless for blobs. Our own media is
  // same-origin, so this keeps the canvas untainted.
  video.crossOrigin = "anonymous";
  video.src = objectUrl ?? (src );

  const dispose = () => {
    video.removeAttribute("src");
    video.load();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  };

  try {
    await once(video, "loadedmetadata");
  } catch (e) {
    dispose();
    throw e;
  }
  return { video, dispose };
}

/** Draw the video's current frame to a JPEG data URL, stepping the quality
 *  ladder down until it fits the same budget reference uploads use. */
export function drawFrame(video) {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) throw new Error("The video reported no dimensions.");

  for (const { dim, quality } of REF_BUDGET_STEPS) {
    const scale = Math.min(1, dim / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Could not get a 2D canvas context.");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    let dataUrl;
    try {
      dataUrl = canvas.toDataURL("image/jpeg", quality);
    } catch {
      // Tainted canvas — a cross-origin video without CORS headers.
      throw new Error(
        "This video is served from another origin without CORS, so a frame cannot be read from it."
      );
    }
    // Single frames are small, so the first step almost always wins; the ladder
    // exists so an 8K clip cannot blow the request budget on its own.
    if (dataUrlBytes(dataUrl) <= REF_SINGLE_BUDGET_BYTES) return dataUrl;
  }
  // Last step is the guaranteed-to-fit floor; recompute it and accept.
  const last = REF_BUDGET_STEPS[REF_BUDGET_STEPS.length - 1];
  const scale = Math.min(1, last.dim / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", last.quality);
}

/** Per-frame ceiling. Generous because a frame is one reference among several
 *  and the batch ladder in PromptComposer still governs the whole payload. */
const REF_SINGLE_BUDGET_BYTES = 1_500_000;

/** Seek to a time and wait until that frame is actually painted. */
export async function seekTo(video, time) {
  const target = Math.min(Math.max(0, time), Math.max(0, video.duration - 0.05));
  if (Math.abs(video.currentTime - target) < 0.001 && video.readyState >= 2) return;
  video.currentTime = target;
  await once(video, "seeked");
}

/**
 * One-shot: extract a single frame from a video source.
 *
 * `at` defaults to a little into the clip rather than 0 — the very first frame
 * is frequently black or a fade-in, which makes a poor reference.
 */
export async function extractFrame(
  src,
  at
) {
  const { video, dispose } = await loadVideo(src);
  try {
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const time = at ?? Math.min(duration * 0.1 || 0, 1);
    await seekTo(video, time);
    return {
      dataUrl: drawFrame(video),
      time: video.currentTime,
      duration,
      width: video.videoWidth,
      height: video.videoHeight,
    };
  } finally {
    dispose();
  }
}

/** Is this file something we can pull a frame out of? */
export function isVideoFile(file) {
  return file.type.startsWith("video/");
}
