import { randomUUID } from "crypto";
import {
  uploadBase64,
  uploadFromUrl as storageUploadFromUrl,
  splitDataUrl,
  deleteByUrls,
  readAsBase64,
} from "./storage";

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
