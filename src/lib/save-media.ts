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

export class InvalidAvatarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAvatarError";
  }
}

/**
 * Media persistence — now backed by Supabase Storage (was the local filesystem).
 * Function names/signatures are kept so the API routes don't need to change.
 * Returns are public bucket URLs.
 */

/** Save raw bytes (base64) as a generation result; returns its public URL. */
export async function saveBase64(
  base64: string,
  ext: string,
  id: string
): Promise<string> {
  return uploadBase64(base64, `generations/${id}.${ext}`, ext);
}

/** Download a remote url (e.g. provider video) and store it; returns URL. */
export async function saveFromUrl(
  url: string,
  ext: string,
  id: string
): Promise<string> {
  return storageUploadFromUrl(url, `generations/${id}.${ext}`, ext);
}

/** Persist an asset reference image (data URL); returns its public URL. */
export async function saveAssetImage(dataUrl: string): Promise<string> {
  const { ext, data } = splitDataUrl(dataUrl);
  return uploadBase64(data, `assets/${randomUUID()}.${ext}`, ext);
}

/** Delete a stored image by its public URL. Best-effort. */
export async function deleteAssetImage(url: string): Promise<void> {
  await deleteByUrls([url]);
}

/** Normalize an uploaded profile image and store it under a non-reused key. */
export async function saveAvatarImage(input: Buffer): Promise<string> {
  if (!input.length) throw new InvalidAvatarError("The selected image is empty.");
  if (input.length > MAX_AVATAR_UPLOAD_BYTES) {
    throw new InvalidAvatarError("Profile images must be 3 MB or smaller.");
  }

  let normalized: Buffer;
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
export async function deleteAvatarImage(url: string | null): Promise<void> {
  if (url) await deleteByUrls([url]);
}

/** Read a stored image (public URL or data URL) back as base64 + mime. */
export async function readImageAsBase64(
  ref: string
): Promise<{ mimeType: string; data: string }> {
  return readAsBase64(ref);
}

/**
 * Persist the reference images used for a generation. New data URLs are
 * uploaded; existing stored URLs (e.g. cloned items) pass through unchanged.
 */
export async function saveReferenceImages(
  inputs: string[],
  id: string
): Promise<string[]> {
  const out: string[] = [];
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
