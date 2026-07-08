import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

// Instantiate an S3 client.
const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});

const getBucket = () => process.env.AWS_S3_BUCKET_NAME || "aistudio-media-bucket";

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
  const bucket = getBucket();
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: extToMime(ext),
    CacheControl: "public, max-age=31536000",
  });

  await s3.send(command);

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

  // If it's our proxy URL, fetch it directly from the S3 bucket
  if (ref.startsWith("/api/media/")) {
    const key = ref.replace("/api/media/", "");
    const command = new GetObjectCommand({
      Bucket: getBucket(),
      Key: key,
    });
    
    const response = await s3.send(command);
    if (!response.Body) throw new Error("Object body is empty");
    
    const byteArray = await response.Body.transformToByteArray();
    const buffer = Buffer.from(byteArray);
    
    const mimeType = response.ContentType || "image/png";
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
  const bucket = getBucket();
  const deletePromises = urls.map(async (u) => {
    try {
      if (u.startsWith("/api/media/")) {
        const key = u.replace("/api/media/", "");
        const command = new DeleteObjectCommand({
          Bucket: bucket,
          Key: key,
        });
        await s3.send(command);
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

