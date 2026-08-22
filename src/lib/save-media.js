import { randomUUID } from "crypto";
import sharp from "sharp";
import {
  uploadBuffer,
  uploadBase64,
  uploadFromUrl as storageUploadFromUrl,
  splitDataUrl,
  deleteByUrls,
  readAsBase64,
} from "./storage";

export const MAX_AVATAR_UPLOAD_BYTES = 3 * 1024 * 1024;
export const MAX_CANVAS_UPLOAD_BYTES = 8 * 1024 * 1024;

export class InvalidAvatarError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidAvatarError";
  }
}

/**
 * Media persistence backed by Google Cloud Storage.
 * Function names/signatures are kept so the API routes don't need to change.
 * Returns are stable same-origin compatibility URLs.
 */

/** Save raw bytes (base64) as a generation result; returns its public URL. */
export async function saveBase64(
  base64,
  ext,
  id
) {
  return uploadBase64(base64, `generations/${id}.${ext}`, ext);
}

/** Download a remote url (e.g. provider video) and store it; returns URL. */
export async function saveFromUrl(
  url,
  ext,
  id
) {
  return storageUploadFromUrl(url, `generations/${id}.${ext}`, ext);
}

/** Persist an asset reference image (data URL); returns its public URL. */
export async function saveAssetImage(dataUrl) {
  const { ext, data } = splitDataUrl(dataUrl);
  return uploadBase64(data, `assets/${randomUUID()}.${ext}`, ext);
}

/** Delete a stored image by its public URL. Best-effort. */
export async function deleteAssetImage(url) {
  await deleteByUrls([url]);
}

/**
 * Persist a canvas board image upload/paste (data URL); returns its public URL.
 *
 * `boardId` namespaces the stored key. It is optional only so the signature
 * stays backward compatible; every real caller passes one, because a key that
 * records which board an object belongs to is what makes an orphaned canvas
 * upload identifiable after the board is deleted. Callers are responsible for
 * having verified the board exists — this function does not check.
 */
export async function saveCanvasAsset(dataUrl, boardId) {
  const { ext, data } = splitDataUrl(dataUrl);
  // data is base64; raw byte length is ~3/4 of the encoded string length.
  if (Buffer.byteLength(data, "base64") > MAX_CANVAS_UPLOAD_BYTES) {
    throw new Error("Images must be 8 MB or smaller.");
  }
  const prefix = boardId ? `canvas/${boardId}` : "canvas";
  return uploadBase64(data, `${prefix}/${randomUUID()}.${ext}`, ext);
}

/** Normalize an uploaded profile image and store it under a non-reused key. */
export async function saveAvatarImage(input) {
  if (!input.length) throw new InvalidAvatarError("The selected image is empty.");
  if (input.length > MAX_AVATAR_UPLOAD_BYTES) {
    throw new InvalidAvatarError("Profile images must be 3 MB or smaller.");
  }

  let normalized;
  try {
    normalized = await sharp(input, {
      failOn: "error",
      limitInputPixels: 40_000_000,
      sequentialRead: true,
    })
      .rotate()
      .resize(512, 512, { fit: "cover", position: "centre" })
      .webp({ quality: 84 })
      .toBuffer();
  } catch {
    throw new InvalidAvatarError("The selected file is not a valid image.");
  }

  return uploadBuffer(normalized, `avatars/${randomUUID()}.webp`, "webp");
}

/** Delete a prior profile image after a replacement/removal. Best-effort. */
export async function deleteAvatarImage(url) {
  if (url) await deleteByUrls([url]);
}

/** Read a stored image (public URL or data URL) back as base64 + mime. */
export async function readImageAsBase64(
  ref
) {
  return readAsBase64(ref);
}

/**
 * Persist the reference images used for a generation. New data URLs are
 * uploaded; existing stored URLs (e.g. cloned items) pass through unchanged.
 */
export async function saveReferenceImages(
  inputs,
  id
) {
  const out = [];
  let n = 0;
  for (const input of inputs) {
    if (typeof input !== "string") continue;
    if (!input.startsWith("data:")) {
      out.push(input);
      continue;
    }
    const { ext, data } = splitDataUrl(input);
    out.push(await uploadBase64(data, `references/${id}-${n++}.${ext}`, ext));
  }
  return out;
}
