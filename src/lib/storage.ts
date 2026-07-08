import { put, del } from "@vercel/blob";

export const MEDIA_BUCKET = "media";

function extToMime(ext: string): string {
  const e = ext.toLowerCase();
  if (e === "jpg" || e === "jpeg") return "image/jpeg";
  if (e === "mp4") return "video/mp4";
  if (e === "webp") return "image/webp";
  return `image/${e || "png"}`;
}

/** Upload raw bytes; returns the public URL. */
export async function uploadBuffer(
  buffer: Buffer,
  key: string,
  ext: string
): Promise<string> {
  const { url } = await put(key, buffer, {
    access: "public",
    token: process.env.PUBLIC_BLOB_READ_WRITE_TOKEN,
    addRandomSuffix: false,
    contentType: extToMime(ext),
  });
  return url;
}

/** Upload a base64 payload; returns the public URL. */
export async function uploadBase64(
  base64: string,
  key: string,
  ext: string
): Promise<string> {
  return uploadBuffer(Buffer.from(base64, "base64"), key, ext);
}

/** Split a data URL into ext + base64. */
export function splitDataUrl(input: string): { ext: string; data: string } {
  const m = input.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.*)$/s);
  if (m) {
    const ext = m[1] === "jpeg" ? "jpg" : m[1].toLowerCase();
    return { ext, data: m[2] };
  }
  return { ext: "png", data: input };
}

/** Download a remote URL (e.g. a provider video) and store it; returns URL. */
export async function uploadFromUrl(
  url: string,
  key: string,
  ext: string
): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download media (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  return uploadBuffer(buf, key, ext);
}

/** Read a stored object (public URL or path) back as base64 + mime. */
export async function readAsBase64(
  ref: string
): Promise<{ mimeType: string; data: string }> {
  if (ref.startsWith("data:")) {
    const m = ref.match(/^data:([^;]+);base64,(.*)$/s);
    if (m) return { mimeType: m[1], data: m[2] };
    return { mimeType: "image/png", data: ref };
  }

  // Handle legacy local URLs in dev mode
  let targetUrl = ref;
  if (ref.startsWith("/")) {
    targetUrl = `http://localhost:${process.env.PORT || 3000}${ref}`;
  }

  const res = await fetch(targetUrl);
  if (!res.ok) throw new Error(`Failed to read media (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mimeType = res.headers.get("content-type") || "image/png";
  return { mimeType, data: buf.toString("base64") };
}

/** Delete objects by their public URL or storage key. Best-effort. */
export async function deleteByUrls(urls: string[]): Promise<void> {
  try {
    // Vercel Blob `del` takes public URLs
    // We filter out any legacy local relative URLs that might crash the SDK.
    const validUrls = urls.filter((u) => u.startsWith("http"));
    if (validUrls.length > 0) {
      await del(validUrls, { token: process.env.PUBLIC_BLOB_READ_WRITE_TOKEN });
    }
  } catch (err) {
    // best effort deletion
  }
}

/** Ensure the public media bucket exists (idempotent — used by seed). */
export async function ensureBucket(): Promise<void> {
  // Vercel Blob doesn't require explicit bucket creation on disk
  return Promise.resolve();
}
