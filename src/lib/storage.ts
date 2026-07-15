import { Readable } from "node:stream";
import { Storage, type StorageOptions } from "@google-cloud/storage";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { gcpProjectId, getStorageAuth } from "./gcp-auth";

const getBucketName = () =>
  process.env.GCP_MEDIA_BUCKET ||
  process.env.GCS_BUCKET_NAME ||
  "aistudio-media-bucket";

const legacyBucketName = () =>
  process.env.AWS_S3_BUCKET_NAME || "aistudio-media-bucket";

const legacyReadsEnabled = () =>
  process.env.GCS_MIGRATION_READ_FALLBACK === "1" &&
  !!process.env.AWS_ACCESS_KEY_ID;

const primaryIsGcs = () => process.env.MEDIA_BACKEND === "gcs";

let storageClient: Storage | undefined;
let legacyS3Client: S3Client | undefined;

function storage(): Storage {
  storageClient ??= new Storage({
    projectId: gcpProjectId(),
    authClient: getStorageAuth() as unknown as StorageOptions["authClient"],
  });
  return storageClient;
}

function legacyS3(): S3Client {
  legacyS3Client ??= new S3Client({
    region: process.env.AWS_REGION || "us-east-1",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
    },
  });
  return legacyS3Client;
}

export const MEDIA_BUCKET = "media";

function extToMime(ext: string): string {
  const e = ext.toLowerCase();
  if (e === "jpg" || e === "jpeg") return "image/jpeg";
  if (e === "mp4") return "video/mp4";
  if (e === "webm") return "video/webm";
  if (e === "webp") return "image/webp";
  if (e === "gif") return "image/gif";
  if (e === "json") return "application/json";
  return `image/${e || "png"}`;
}

function isNotFound(error: unknown): boolean {
  const e = error as { code?: number | string; name?: string };
  return e?.code === 404 || e?.code === "404" || e?.name === "NoSuchKey";
}

function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

export function mediaKeyFromRef(ref: string): string | null {
  if (ref.startsWith("/api/media/")) return ref.slice("/api/media/".length);
  const cdn = process.env.GCP_MEDIA_CDN_URL?.replace(/\/$/, "");
  if (cdn && ref.startsWith(`${cdn}/`)) {
    return decodeURIComponent(ref.slice(cdn.length + 1));
  }
  return null;
}

export function getMediaRedirectUrl(key: string): string | null {
  if (!primaryIsGcs()) return null;
  const base = process.env.GCP_MEDIA_CDN_URL?.replace(/\/$/, "");
  return base ? `${base}/${encodeKey(key)}` : null;
}

async function saveBuffer(
  buffer: Buffer,
  key: string,
  contentType: string,
  cacheControl: string
): Promise<void> {
  if (!primaryIsGcs()) {
    await legacyS3().send(
      new PutObjectCommand({
        Bucket: legacyBucketName(),
        Key: key,
        Body: buffer,
        ContentType: contentType,
        CacheControl: cacheControl,
      })
    );
    return;
  }
  await storage().bucket(getBucketName()).file(key).save(buffer, {
    resumable: buffer.byteLength >= 8 * 1024 * 1024,
    contentType,
    metadata: { cacheControl },
    validation: "crc32c",
  });
}

/** Upload media to the selected backend and return its stable compatibility URL. */
export async function uploadBuffer(
  buffer: Buffer,
  key: string,
  ext: string
): Promise<string> {
  await saveBuffer(
    buffer,
    key,
    extToMime(ext),
    "public, max-age=31536000, immutable"
  );
  return `/api/media/${key}`;
}

export async function writePrivateBuffer(
  buffer: Buffer,
  key: string,
  contentType = "application/octet-stream"
): Promise<void> {
  await saveBuffer(buffer, key, contentType, "private, no-store");
}

export async function uploadBase64(
  base64: string,
  key: string,
  ext: string
): Promise<string> {
  return uploadBuffer(Buffer.from(base64, "base64"), key, ext);
}

const ALLOWED_DATA_URL_MIME_EXT: Record<string, string> = {
  jpeg: "jpg",
  jpg: "jpg",
  png: "png",
  webp: "webp",
  gif: "gif",
};

export function splitDataUrl(input: string): { ext: string; data: string } {
  const m = input.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.*)$/s);
  const subtype = m?.[1]?.toLowerCase();
  const ext = subtype ? ALLOWED_DATA_URL_MIME_EXT[subtype] : undefined;
  if (!m || !ext) {
    throw new Error("Unsupported image type. Use JPEG, PNG, WebP, or GIF.");
  }
  return { ext, data: m[2] };
}

export async function uploadFromUrl(
  url: string,
  key: string,
  ext: string
): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download media (${res.status})`);
  return uploadBuffer(Buffer.from(await res.arrayBuffer()), key, ext);
}

async function readLegacyObject(
  key: string
): Promise<{ buffer: Buffer; contentType: string }> {
  const response = await legacyS3().send(
    new GetObjectCommand({ Bucket: legacyBucketName(), Key: key })
  );
  if (!response.Body) throw new Error("Legacy S3 object body is empty");
  return {
    buffer: Buffer.from(await response.Body.transformToByteArray()),
    contentType: response.ContentType || extToMime(key.split(".").pop() || "png"),
  };
}

async function readLegacyBuffer(key: string): Promise<Buffer> {
  return (await readLegacyObject(key)).buffer;
}

export async function readStoredBuffer(key: string): Promise<Buffer> {
  if (!primaryIsGcs()) return readLegacyBuffer(key);
  try {
    const [buffer] = await storage().bucket(getBucketName()).file(key).download();
    return buffer;
  } catch (error) {
    if (isNotFound(error) && legacyReadsEnabled()) return readLegacyBuffer(key);
    throw error;
  }
}

export async function readAsBase64(
  ref: string
): Promise<{ mimeType: string; data: string }> {
  if (ref.startsWith("data:")) {
    const m = ref.match(/^data:([^;]+);base64,(.*)$/s);
    if (m) return { mimeType: m[1], data: m[2] };
    return { mimeType: "image/png", data: ref };
  }

  const key = mediaKeyFromRef(ref);
  if (key) {
    if (!primaryIsGcs()) {
      const object = await readLegacyObject(key);
      return {
        mimeType: object.contentType,
        data: object.buffer.toString("base64"),
      };
    }
    try {
      const file = storage().bucket(getBucketName()).file(key);
      const [[buffer], [metadata]] = await Promise.all([
        file.download(),
        file.getMetadata(),
      ]);
      return {
        mimeType: metadata.contentType || "image/png",
        data: buffer.toString("base64"),
      };
    } catch (error) {
      if (isNotFound(error) && legacyReadsEnabled()) {
        const object = await readLegacyObject(key);
        return {
          mimeType: object.contentType,
          data: object.buffer.toString("base64"),
        };
      }
      throw error;
    }
  }

  if (ref.startsWith("http")) {
    const res = await fetch(ref);
    if (!res.ok) throw new Error(`Failed to read media (${res.status})`);
    return {
      mimeType: res.headers.get("content-type") || "image/png",
      data: Buffer.from(await res.arrayBuffer()).toString("base64"),
    };
  }

  throw new Error(`Unsupported media reference format: ${ref}`);
}

export class MediaNotFoundError extends Error {}
export class InvalidMediaRangeError extends Error {}

function parseRange(range: string, size: number): { start: number; end: number } {
  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2]) || size <= 0) {
    throw new InvalidMediaRangeError();
  }
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) throw new InvalidMediaRangeError();
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (start < 0 || start >= size || end < start) throw new InvalidMediaRangeError();
  return { start, end: Math.min(end, size - 1) };
}

export interface OpenMediaObject {
  stream: ReadableStream<Uint8Array>;
  contentType: string;
  contentLength: number;
  contentRange?: string;
  status: 200 | 206;
}

async function openLegacyMedia(
  key: string,
  range?: string
): Promise<OpenMediaObject> {
  try {
    const response = await legacyS3().send(
      new GetObjectCommand({ Bucket: legacyBucketName(), Key: key, Range: range })
    );
    if (!response.Body) throw new MediaNotFoundError();
    return {
      stream: response.Body.transformToWebStream() as ReadableStream<Uint8Array>,
      contentType: response.ContentType || "application/octet-stream",
      contentLength: Number(response.ContentLength || 0),
      contentRange: response.ContentRange,
      status: range ? 206 : 200,
    };
  } catch (error) {
    if (isNotFound(error)) throw new MediaNotFoundError();
    throw error;
  }
}

export async function openMediaObject(
  key: string,
  range?: string
): Promise<OpenMediaObject> {
  if (!primaryIsGcs()) return openLegacyMedia(key, range);
  try {
    const file = storage().bucket(getBucketName()).file(key);
    const [metadata] = await file.getMetadata();
    const size = Number(metadata.size || 0);
    const parsed = range ? parseRange(range, size) : undefined;
    const nodeStream = file.createReadStream(
      parsed
        ? { start: parsed.start, end: parsed.end, validation: false }
        : { validation: false }
    );
    return {
      stream: Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>,
      contentType: metadata.contentType || "application/octet-stream",
      contentLength: parsed ? parsed.end - parsed.start + 1 : size,
      contentRange: parsed ? `bytes ${parsed.start}-${parsed.end}/${size}` : undefined,
      status: parsed ? 206 : 200,
    };
  } catch (error) {
    if (!isNotFound(error)) throw error;
    if (!legacyReadsEnabled()) throw new MediaNotFoundError();

    return openLegacyMedia(key, range);
  }
}

export async function deleteByUrls(urls: string[]): Promise<void> {
  const results = urls.map(async (ref) => {
    const key = mediaKeyFromRef(ref);
    if (!key) return;
    if (primaryIsGcs()) {
      await storage()
        .bucket(getBucketName())
        .file(key)
        .delete({ ignoreNotFound: true });
    }
    if (!primaryIsGcs() || legacyReadsEnabled()) {
      await legacyS3().send(
        new DeleteObjectCommand({ Bucket: legacyBucketName(), Key: key })
      );
    }
  });
  await Promise.allSettled(results);
}

export async function checkStorageConnectivity(): Promise<string> {
  if (!primaryIsGcs()) {
    await legacyS3().send(new HeadBucketCommand({ Bucket: legacyBucketName() }));
    return `S3 bucket ${legacyBucketName()}`;
  }
  const [exists] = await storage().bucket(getBucketName()).exists();
  if (!exists) throw new Error(`GCS bucket ${getBucketName()} does not exist`);
  return `GCS bucket ${getBucketName()}`;
}

export async function ensureBucket(): Promise<void> {
  await checkStorageConnectivity();
}
