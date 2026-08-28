import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import sharp from "sharp";
import { getModelDefinition } from "./model-registry";

const VIDEO_INSPECTION_TIMEOUT_MS = 30_000;
const DEFAULT_RATIOS = {
  image: ["1:1", "3:4", "4:3", "9:16", "16:9", "21:9"],
  video: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
};

/** Return the supported ratio closest to real pixel dimensions.
 *
 * Log distance makes reciprocal errors symmetric: the distance from 4:3 to
 * 16:9 is treated the same as 3:4 to 9:16. Invalid dimensions and malformed
 * ratio labels deliberately produce undefined so callers can retain the
 * requested value.
 */
export function nearestSupportedAspectRatio(width, height, supportedRatios) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return undefined;
  }
  const target = Math.log(width / height);
  let best;
  let bestDelta = Infinity;
  for (const label of supportedRatios ?? []) {
    const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(label));
    if (!match) continue;
    const w = Number(match[1]);
    const h = Number(match[2]);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) continue;
    const delta = Math.abs(Math.log(w / h) - target);
    if (delta < bestDelta) {
      best = label;
      bestDelta = delta;
    }
  }
  return best;
}

export async function inspectImageDimensions(buffer) {
  const metadata = await sharp(buffer, {
    failOn: "error",
    limitInputPixels: 100_000_000,
    sequentialRead: true,
  }).metadata();
  const width = metadata.autoOrient?.width ?? metadata.width;
  const height = metadata.autoOrient?.height ?? metadata.height;
  if (!width || !height) {
    throw new Error("Image metadata did not contain dimensions.");
  }
  return { width, height };
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath.path,
      args,
      { timeout: VIDEO_INSPECTION_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ""}\n${stderr ?? ""}`;
        if (error) {
          reject(new Error(`ffmpeg metadata inspection failed: ${error.message}`));
          return;
        }
        resolve(output);
      }
    );
  });
}

/** Inspect the first decoded video frame using the bundled ffmpeg runtime.
 * showinfo reports the post-autorotation frame size, which is the shape users
 * actually see and therefore the one the library card should use.
 */
export async function inspectVideoDimensions(buffer, ext = "mp4") {
  const directory = await mkdtemp(path.join(tmpdir(), "veevee-media-metadata-"));
  const inputPath = path.join(directory, `input.${String(ext).replace(/[^a-z0-9]/gi, "") || "mp4"}`);
  try {
    await writeFile(inputPath, buffer);
    const output = await runFfmpeg([
      "-nostdin",
      "-hide_banner",
      "-i", inputPath,
      "-map", "0:v:0",
      "-frames:v", "1",
      "-vf", "showinfo",
      "-f", "null",
      "-",
    ]);
    const showInfo = /\bs:(\d{1,6})x(\d{1,6})\b/.exec(output);
    const streamInfo = /Video:[^\n]*?\b(\d{2,6})x(\d{2,6})\b/.exec(output);
    const match = showInfo ?? streamInfo;
    const width = Number(match?.[1]);
    const height = Number(match?.[2]);
    if (!width || !height) throw new Error("ffmpeg did not report video dimensions.");
    return { width, height };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

export async function inspectGeneratedMedia(buffer, kind, ext) {
  if (kind === "image") return inspectImageDimensions(buffer);
  if (kind === "video") return inspectVideoDimensions(buffer, ext);
  throw new Error(`Unsupported generated media kind: ${kind}`);
}

function warnStructured(warn, payload) {
  try {
    warn("[generation_asset_metadata]", payload);
  } catch {
    // Logging/telemetry is observational and must not invalidate paid output.
  }
}

/**
 * Inspect a paid provider result without allowing metadata work to invalidate
 * the successful generation. The buffer is the same one persistence uploads;
 * no provider URL is fetched here.
 */
export async function measureGeneratedMedia({
  buffer,
  kind,
  ext,
  model,
  requestedAspectRatio,
  generationId,
  warn = console.warn,
}) {
  try {
    const { width, height } = await inspectGeneratedMedia(buffer, kind, ext);
    const supportedRatios =
      getModelDefinition(model)?.capabilities?.aspectRatios ?? DEFAULT_RATIOS[kind] ?? [];
    const measuredAspectRatio = nearestSupportedAspectRatio(width, height, supportedRatios);
    if (!measuredAspectRatio) throw new Error("No supported aspect ratio could be selected.");
    if (measuredAspectRatio !== requestedAspectRatio) {
      warnStructured(warn, {
        event: "generation_aspect_mismatch",
        generationId,
        kind,
        model,
        requestedAspectRatio,
        measuredAspectRatio,
        width,
        height,
      });
    }
    return { width, height, aspectRatio: measuredAspectRatio };
  } catch (error) {
    warnStructured(warn, {
      event: "generation_dimension_inspection_failed",
      generationId,
      kind,
      model,
      requestedAspectRatio,
      error: error?.message ?? String(error),
    });
    return { aspectRatio: requestedAspectRatio };
  }
}
