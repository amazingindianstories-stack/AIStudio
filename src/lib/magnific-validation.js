import sharp from "sharp";
import { MAGNIFIC_CREATIVE_PRESETS, MAGNIFIC_ENGINES, MAGNIFIC_MODELS, MAGNIFIC_PRECISION_FLAVORS, MAGNIFIC_SCALE_FACTORS } from "./providers/magnific";

export const MAX_UPSCALE_BYTES = 20 * 1024 * 1024;
export const MAX_UPSCALE_PIXELS = 40_000_000;
export const MAX_UPSCALE_PROMPT = 2_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

export class InvalidUpscaleRequest extends Error {}
const fail = (message) => { throw new InvalidUpscaleRequest(message); };
const numberIn = (value, min, max, name) => {
  if (!Number.isFinite(value) || value < min || value > max) fail(`${name} must be between ${min} and ${max}.`);
};

export function validateUpscaleRequest(body = {}) {
  if (!MAGNIFIC_MODELS.includes(body.model)) fail("Unsupported upscale model.");
  if (typeof body.image !== "string" || !body.image) fail("Source image is required for upscaling.");
  if (body.projectId != null && !UUID.test(body.projectId)) fail("Invalid projectId.");
  if (body.folderId != null && !UUID.test(body.folderId)) fail("Invalid folderId.");
  const p = body.params;
  if (!p || typeof p !== "object" || Array.isArray(p)) fail("Invalid upscale parameters.");
  const allowed = body.model === "Magnific Creative"
    ? new Set(["model", "scaleFactor", "optimizedFor", "engine", "creativity", "hdr", "resemblance", "fractality", "filterNsfw", "prompt"])
    : body.model === "Magnific Precision V2"
      ? new Set(["model", "scaleFactor", "flavor", "sharpen", "smartGrain", "ultraDetail", "filterNsfw"])
      : new Set(["model", "sharpen", "smartGrain", "ultraDetail", "filterNsfw"]);
  for (const key of Object.keys(p)) if (!allowed.has(key)) fail(`Parameter ${key} is not supported by ${body.model}.`);
  if (p.model != null && p.model !== body.model) fail("Parameter model does not match model.");
  if (p.prompt != null && (typeof p.prompt !== "string" || p.prompt.length > MAX_UPSCALE_PROMPT)) fail("Prompt must be 2000 characters or fewer.");
  if (p.filterNsfw != null && typeof p.filterNsfw !== "boolean") fail("filterNsfw must be boolean.");
  if (body.model === "Magnific Creative") {
    if (!MAGNIFIC_SCALE_FACTORS.includes(p.scaleFactor)) fail("Invalid scaleFactor.");
    if (!MAGNIFIC_CREATIVE_PRESETS.some((x) => x.id === p.optimizedFor)) fail("Invalid optimizedFor preset.");
    if (!MAGNIFIC_ENGINES.some((x) => x.id === p.engine)) fail("Invalid engine.");
    for (const key of ["creativity", "hdr", "resemblance", "fractality"]) numberIn(p[key], -10, 10, key);
  } else {
    for (const key of ["sharpen", "smartGrain", "ultraDetail"]) numberIn(p[key], 0, 100, key);
    if (body.model === "Magnific Precision V2") {
      if (!MAGNIFIC_SCALE_FACTORS.includes(p.scaleFactor)) fail("Invalid scaleFactor.");
      if (!MAGNIFIC_PRECISION_FLAVORS.some((x) => x.id === p.flavor)) fail("Invalid flavor.");
    }
  }
  return { ...body, params: p };
}

export function validateUpscaleSourceReference(value, origin) {
  if (value.startsWith("data:")) return;
  let url;
  try { url = new URL(value, origin); } catch { fail("Invalid source image URL."); }
  if (url.origin !== origin || !url.pathname.startsWith("/api/media/")) fail("Source image must be uploaded to this application.");
}

export async function inspectUpscaleImage(data, declaredMime) {
  const buffer = Buffer.from(data, "base64");
  if (buffer.length > MAX_UPSCALE_BYTES) fail("Source image must be 20 MB or smaller.");
  if (!IMAGE_MIMES.has(String(declaredMime).toLowerCase())) fail("Source must be a JPEG, PNG, or WebP image.");
  let meta;
  try { meta = await sharp(buffer, { failOn: "error", limitInputPixels: MAX_UPSCALE_PIXELS }).metadata(); }
  catch { fail("Source is not a valid supported image."); }
  if (!meta.width || !meta.height || meta.width * meta.height > MAX_UPSCALE_PIXELS) fail("Source image exceeds the 40 megapixel limit.");
  const detected = `image/${meta.format === "jpg" ? "jpeg" : meta.format}`;
  if (!IMAGE_MIMES.has(detected) || detected !== declaredMime.toLowerCase()) fail("Source image type does not match its contents.");
  return { buffer, meta };
}
