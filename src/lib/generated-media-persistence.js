import { uploadBuffer } from "./storage";
import { measureGeneratedMedia } from "./generated-media-metadata";

/** Persist already-held provider bytes and return measured display metadata.
 * Inspection is fail-open inside measureGeneratedMedia: only persistence
 * errors reject, so a metadata parser can never discard a paid result. */
export async function saveBufferWithMetadata(buffer, ext, id, metadata) {
  const url = await uploadBuffer(buffer, `generations/${id}.${ext}`, ext);
  const measured = await measureGeneratedMedia({
    buffer,
    ext,
    generationId: id,
    ...metadata,
  });
  return { url, ...measured };
}

/** Base64-compatible measured variant. The legacy saveBase64 URL contract is unchanged. */
export async function saveBase64WithMetadata(base64, ext, id, metadata) {
  return saveBufferWithMetadata(Buffer.from(base64, "base64"), ext, id, metadata);
}

/** Download once, then use the same bytes for upload and video/image inspection. */
export async function saveFromUrlWithMetadata(url, ext, id, metadata, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Failed to download media (${response.status})`);
  const buffer = Buffer.from(await response.arrayBuffer());
  return saveBufferWithMetadata(buffer, ext, id, metadata);
}
