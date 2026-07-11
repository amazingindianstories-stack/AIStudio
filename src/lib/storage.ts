import { Storage } from "@google-cloud/storage";

// Instantiate a GCS client.
// It automatically uses Application Default Credentials when running on GCP,
// or falls back to GOOGLE_APPLICATION_CREDENTIALS locally.
const storage = new Storage();

const getBucket = () => process.env.GCS_BUCKET_NAME || "aistudio-media-bucket-gcp";

export const MEDIA_BUCKET = "media";

function extToMime(ext: string): string {
  const e = ext.toLowerCase();
  if (e === "jpg" || e === "jpeg") return "image/jpeg";
  if (e === "mp4") return "video/mp4";
  if (e === "webp") return "image/webp";
  return `image/${e || "png"}`;
}

/** Upload raw bytes; returns the proxy URL. */
export async function uploadBuffer(
  buffer: Buffer,
  key: string,
  ext: string
): Promise<string> {
  const bucketName = getBucket();
  const file = storage.bucket(bucketName).file(key);

  await file.save(buffer, {
    contentType: extToMime(ext),
    metadata: {
      cacheControl: "public, max-age=31536000",
    },
  });

  return `/api/media/${key}`;
}

/** Upload a base64 payload; returns the proxy URL. */
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

/** Download a remote URL (e.g. a provider video) and store it; returns proxy URL. */
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

/** Read a stored object (proxy URL or path) back as base64 + mime. */
export async function readAsBase64(
  ref: string
): Promise<{ mimeType: string; data: string }> {
  if (ref.startsWith("data:")) {
    const m = ref.match(/^data:([^;]+);base64,(.*)$/s);
    if (m) return { mimeType: m[1], data: m[2] };
    return { mimeType: "image/png", data: ref };
  }

  // If it's our proxy URL, fetch it directly from the GCS bucket
  if (ref.startsWith("/api/media/")) {
    const key = ref.replace("/api/media/", "");
    const file = storage.bucket(getBucket()).file(key);
    
    const [buffer] = await file.download();
    const [metadata] = await file.getMetadata();
    
    const mimeType = metadata.contentType || "image/png";
    return { mimeType, data: buffer.toString("base64") };
  }

  // Handle external HTTP URLs
  if (ref.startsWith("http")) {
    const res = await fetch(ref);
    if (!res.ok) throw new Error(`Failed to read media (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    const mimeType = res.headers.get("content-type") || "image/png";
    return { mimeType, data: buf.toString("base64") };
  }

  throw new Error(`Unsupported media reference format: ${ref}`);
}

/** Delete objects by their proxy URL. Best-effort. */
export async function deleteByUrls(urls: string[]): Promise<void> {
  const bucketName = getBucket();
  const deletePromises = urls.map(async (u) => {
    try {
      if (u.startsWith("/api/media/")) {
        const key = u.replace("/api/media/", "");
        await storage.bucket(bucketName).file(key).delete();
      }
    } catch (err) {
      console.warn(`Failed to delete ${u}`, err);
    }
  });

  await Promise.allSettled(deletePromises);
}

/** Ensure the bucket exists. (Idempotent) */
export async function ensureBucket(): Promise<void> {
  return Promise.resolve();
}
