import sharp from "sharp";
import { readImageAsBase64 } from "./save-media";
import { mediaKeyFromRef, isProtectedMediaKey, uploadBuffer, signStoredRef } from "./storage";

const MAX_PIXELS = 36_000_000;
const MAX_BYTES = 30_000_000;
const TARGET_BYTES = 29_000_000;
const FORMATS = new Set(["jpeg", "png", "webp", "tiff", "gif", "heif"]);
export async function normalizeSeedreamReference(bytes) {
  let meta;
  try {
    meta = await sharp(bytes, { failOn: "error", limitInputPixels: 150_000_000 }).metadata();
    if (!FORMATS.has(meta.format) || (meta.pages ?? 1) > 1) throw new Error();
    // Decode the complete image: metadata alone accepts truncated files.
    await sharp(bytes, { failOn: "error", limitInputPixels: 150_000_000 }).stats();
  } catch { throw new Error("Reference is corrupt, animated, unsupported, or too large to decode. Use a still PNG, JPEG, WebP, or TIFF image."); }
  const { width, height } = meta;
  if (width <= 14 || height <= 14 || width / height < 1 / 16 || width / height > 16) throw new Error("Reference dimensions must exceed 14 pixels with an aspect ratio between 1:16 and 16:1.");
  if (width * height <= MAX_PIXELS && bytes.length <= MAX_BYTES) return { bytes, ext: meta.format === "jpeg" ? "jpg" : meta.format, changed: false };
  let scale = Math.min(1, Math.sqrt(MAX_PIXELS / (width * height)));
  for (let attempt = 0; attempt < 20; attempt++) {
    const w = Math.floor(width * scale), h = Math.floor(height * scale);
    if (w <= 14 || h <= 14) break;
    const resized = sharp(bytes, { failOn: "error", limitInputPixels: 150_000_000 }).resize(w, h, { fit: "inside", withoutEnlargement: true });
    const output = await (meta.hasAlpha ? resized.png() : resized.jpeg({ quality: 92 })).toBuffer();
    if (output.length < TARGET_BYTES) return { bytes: output, ext: meta.hasAlpha ? "png" : "jpg", changed: true };
    scale *= 0.9;
  }
  throw new Error("Reference could not fit the 30 MB limit. Export a smaller PNG or JPEG.");
}
export async function prepareSeedreamReferences(references, id, { signal, userId, sign = true, persist = true, read = readImageAsBase64, upload = uploadBuffer, signRef = signStoredRef } = {}) {
  const stable = [], urls = [];
  for (const [index, ref] of references.entries()) {
    signal?.throwIfAborted();
    const key = typeof ref === "string" ? mediaKeyFromRef(ref) : null;
    if (!key || isProtectedMediaKey(key) || key.includes("..") || /[?#]/.test(key)) throw new Error("Use an uploaded or stored original image as the reference.");
    if (userId && key.startsWith("uploads/image-reference/") && !key.startsWith(`uploads/image-reference/${userId}-`)) throw new Error("This uploaded reference belongs to another user.");
    let raw;
    try { raw = await read(ref, signal); }
    catch { throw new Error(`Reference ${index + 1} could not be read. Upload it again.`); }
    const normalized = await normalizeSeedreamReference(Buffer.from(raw.data, "base64"));
    const stored = normalized.changed && persist ? await upload(normalized.bytes, `references/${id}-seedream-${index}.${normalized.ext}`, normalized.ext) : ref;
    stable.push(stored);
    if (sign) urls.push(await signRef(stored));
  }
  return { stable, urls };
}
