import { Readable } from "node:stream";
import { Storage, } from "@google-cloud/storage";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { gcpProjectId, getStorageCredentials } from "./gcp-auth";
import {
  isThumbnailable,
  originalKeyFromThumb,
  THUMB_LADDER,
  THUMB_PREFIX,
  thumbKey,
} from "./media-derivatives";

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

let storageClient;
let legacyS3Client;

function storage() {
  if (!storageClient) {
    const credentials = getStorageCredentials();
    storageClient = new Storage({
      projectId: gcpProjectId(),
      ...(credentials ? { credentials } : {}),
    });
  }
  return storageClient;
}

function legacyS3() {
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

function extToMime(ext) {
  const e = ext.toLowerCase();
  if (e === "jpg" || e === "jpeg") return "image/jpeg";
  if (e === "mp4") return "video/mp4";
  if (e === "webm") return "video/webm";
  if (e === "webp") return "image/webp";
  if (e === "gif") return "image/gif";
  if (e === "json") return "application/json";
  return `image/${e || "png"}`;
}

function isNotFound(error) {
  const e = error ;
  return e?.code === 404 || e?.code === "404" || e?.name === "NoSuchKey";
}

function encodeKey(key) {
  return key.split("/").map(encodeURIComponent).join("/");
}

export function mediaKeyFromRef(ref) {
  if (ref.startsWith("/api/media/")) return ref.slice("/api/media/".length);
  const cdn = process.env.GCP_MEDIA_CDN_URL?.replace(/\/$/, "");
  if (cdn && ref.startsWith(`${cdn}/`)) {
    return decodeURIComponent(ref.slice(cdn.length + 1));
  }
  return null;
}

/**
 * A short-lived, publicly fetchable URL for one stored object.
 *
 * Exists for one reason: some providers take a URL rather than inline bytes
 * (ModelArk's `video_url` items), and **they cannot read our media**. Every
 * object is served through `GET /api/media/[...path]`, which requires a session
 * — deliberately, since it previously had no auth at all — so handing a
 * provider that URL gets a 401. Inlining a video as base64 instead would mean
 * holding tens of megabytes in a serverless function, which is exactly what
 * this avoids.
 *
 * Rules, because this deliberately bypasses the auth on that route:
 *  - Never persist one — the whole safety story is that it expires.
 *  - Read-only, single object, no listing.
 *  - This entry point is for the *provider* handoff and keeps a short TTL.
 *    Browser-facing URLs go through `browserMediaUrl`, which is a deliberate
 *    and separately-reasoned exception to what used to be a blanket
 *    "server-side only" rule here — see the note on that function.
 *  - The same `settings/` and `migrations/` prefixes the media route denies are
 *    denied here too. Those hold secrets and DB dumps that share this bucket,
 *    and a presigned URL would be a way around that check.
 */
const SIGNED_URL_TTL_SECONDS = 15 * 60;

/** Prefixes that must never be reachable, matching the media route's denylist. */
const PRESIGN_DENY = /^(settings|migrations)\//i;

/**
 * Whether a key is one of the protected prefixes — checked through the
 * thumbnail namespace as well.
 *
 * `thumbs/512/settings/token.json.webp` starts with `thumbs/`, so a plain
 * prefix test on the requested key says "allowed" while the object it names
 * lives under `settings/`. No such derivative can exist today (settings blobs
 * are written by `writePrivateBuffer`, which never renders thumbnails, and
 * `.json` is not a rasterisable extension), but the whole point of this
 * denylist is that it holds even when something upstream changes. Adding a
 * namespace that embeds arbitrary keys means the check has to see through it.
 */
export function isProtectedMediaKey(key) {
  if (PRESIGN_DENY.test(key)) return true;
  const original = originalKeyFromThumb(key);
  return original ? PRESIGN_DENY.test(original.key) : false;
}

/**
 * V4-sign a read URL over an explicit validity window.
 *
 * `accessibleAt` is pinned rather than defaulted to "now" because the signature
 * covers `X-Goog-Date`: two calls a second apart otherwise produce two
 * different URLs for the same immutable object, and the browser caches by URL.
 * `browserMediaUrl` uses that to hand every request in a time bucket the
 * byte-identical URL, so a re-view is a cache hit instead of a re-download.
 *
 * **Signing under Workload Identity Federation does work**, contrary to what
 * this file used to claim. `@google-cloud/storage` wraps whatever `authClient`
 * it is given in a `GoogleAuth` (nodejs-common/util.js), whose `sign()` sees a
 * `BaseExternalAccountClient`, resolves the impersonated service account via
 * `getServiceAccountEmail()`, and signs through the IAM `signBlob` API — no
 * private key involved. What that call needs is `roles/iam.serviceAccountTokenCreator`
 * for the runtime service account **on itself**: the pool principal already
 * holds that role on the SA (it is how `generateAccessToken` impersonation
 * works), but `signBlob` is invoked with the SA's own impersonated token, so the
 * self-binding is a separate grant and is the thing that was missing when
 * signing failed in production. See `infra/gcp/README.md`.
 */
async function signReadUrl(
  key,
  accessibleAtMs,
  expiresAtMs
) {
  if (isProtectedMediaKey(key)) {
    throw new Error(`Refusing to sign a URL for a protected prefix: ${key}`);
  }
  if (primaryIsGcs()) {
    try {
      const [url] = await storage()
        .bucket(getBucketName())
        .file(key)
        .getSignedUrl({
          version: "v4",
          action: "read",
          accessibleAt: new Date(accessibleAtMs),
          expires: expiresAtMs,
        });
      return url;
    } catch (e) {
      throw new Error(
        `GCS could not sign a URL for ${key}: ${e?.message ?? e}. Signing goes ` +
          `through the IAM signBlob API under Workload Identity Federation, so a ` +
          `permission error here means ${
            process.env.GCP_SERVICE_ACCOUNT_EMAIL ?? "the runtime service account"
          } is missing roles/iam.serviceAccountTokenCreator on itself — see ` +
          `infra/gcp/README.md. Setting GCP_MEDIA_CDN_URL also removes the need ` +
          `to sign at all.`
      );
    }
  }
  try {
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    return await getSignedUrl(
      legacyS3(),
      new GetObjectCommand({ Bucket: legacyBucketName(), Key: key }),
      { expiresIn: Math.max(1, Math.round((expiresAtMs - Date.now()) / 1000)) }
    );
  } catch (e) {
    throw new Error(
      `S3 could not sign a URL for ${key} in bucket ${legacyBucketName()}: ` +
        `${e?.message ?? e}. Presigning is a local computation, so this almost ` +
        `always means AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are missing in ` +
        `this environment.`
    );
  }
}

export async function getSignedReadUrl(
  key,
  ttlSeconds = SIGNED_URL_TTL_SECONDS
) {
  if (isProtectedMediaKey(key)) {
    throw new Error(`Refusing to sign a URL for a protected prefix: ${key}`);
  }
  // A public CDN URL is preferred when one is configured: it needs no signing
  // round-trip at all.
  const cdn = getMediaRedirectUrl(key);
  if (cdn) return cdn;
  const now = Date.now();
  return signReadUrl(key, now, now + ttlSeconds * 1000);
}

/** How long a presigned upload URL stays valid. Longer than the read TTL —
 *  a large video PUT over a home upload link can legitimately take minutes,
 *  and an expired-mid-upload URL fails as a confusing generic network error
 *  rather than a clear "please retry" the caller can act on. */
const SIGNED_UPLOAD_URL_TTL_SECONDS = 30 * 60;

/**
 * A short-lived URL the caller can PUT raw bytes to directly, bypassing this
 * app's own request handlers entirely.
 *
 * Added for the depth-map worker (depth-workers.js): both the browser's
 * input-video upload and the worker's result-video upload are, at video
 * sizes, well over Vercel's 4.5MB body limit that every other upload path in
 * this app (saveReferenceImages, saveBase64, ...) stays under by inlining
 * base64 in the request body. A signed PUT is the same trick
 * getSignedReadUrl/browserMediaUrl already use for reads, mirrored for
 * writes: no bytes ever pass through a serverless function.
 *
 * No CDN shortcut here (unlike getSignedReadUrl) — a public CDN only serves
 * reads, it has no concept of "accept an upload."
 */
export async function getSignedUploadUrl(
  key,
  contentType,
  ttlSeconds = SIGNED_UPLOAD_URL_TTL_SECONDS
) {
  if (isProtectedMediaKey(key)) {
    throw new Error(`Refusing to sign an upload URL for a protected prefix: ${key}`);
  }
  const now = Date.now();
  const expiresAtMs = now + ttlSeconds * 1000;
  if (primaryIsGcs()) {
    try {
      const [url] = await storage()
        .bucket(getBucketName())
        .file(key)
        .getSignedUrl({
          version: "v4",
          action: "write",
          expires: expiresAtMs,
          contentType,
        });
      return url;
    } catch (e) {
      throw new Error(
        `GCS could not sign an upload URL for ${key}: ${e?.message ?? e}. Same ` +
          `IAM signBlob requirement as read signing — see the note on signReadUrl.`
      );
    }
  }
  try {
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    return await getSignedUrl(
      legacyS3(),
      new PutObjectCommand({ Bucket: legacyBucketName(), Key: key, ContentType: contentType }),
      { expiresIn: ttlSeconds }
    );
  } catch (e) {
    throw new Error(
      `S3 could not sign an upload URL for ${key} in bucket ${legacyBucketName()}: ` +
        `${e?.message ?? e}.`
    );
  }
}

/**
 * How long a browser-facing signed URL stays valid, and how coarsely its start
 * time is rounded. Every request landing in the same bucket gets the identical
 * URL (see `signReadUrl`), so the bucket length is also the browser cache
 * lifetime for the bytes; the signature outlives the bucket by one full bucket
 * so a URL minted at the end of one is still good for a while after.
 *
 * The trade-off is the only one here worth tuning: a longer bucket caches
 * better, and also lengthens how long a leaked URL keeps working. These are
 * bearer URLs for a single object, handed to a user who is already authorised
 * to read it, so hours rather than minutes is the right order of magnitude.
 */
const SIGNED_BROWSER_URL_BUCKET_MS =
  Number(process.env.MEDIA_SIGNED_URL_BUCKET_HOURS || 6) * 3600_000;

const browserUrlCache = new Map();

/**
 * A URL the *browser* can fetch directly for one stored object, or null if this
 * deployment cannot produce one (in which case the caller must proxy the bytes).
 *
 * This is what keeps media bytes off the serverless function. Handing a signed
 * URL to the browser is a deliberate widening of `getSignedReadUrl`'s original
 * "server-side only" rule: that rule existed because the URL bypasses the
 * session check on `/api/media`, and the reasoning holds for a *provider* but
 * not for the signed-in user who just proved they may read this object. The
 * denylisted prefixes are still refused, one object at a time, with no listing.
 */
export async function browserMediaUrl(key) {
  if (isProtectedMediaKey(key)) return null;
  const cdn = getMediaRedirectUrl(key);
  if (cdn) return cdn;

  const now = Date.now();
  const cached = browserUrlCache.get(key);
  if (cached && cached.until > now) return cached.url;

  const bucketStart = Math.floor(now / SIGNED_BROWSER_URL_BUCKET_MS) * SIGNED_BROWSER_URL_BUCKET_MS;
  try {
    const url = await signReadUrl(
      key,
      bucketStart,
      bucketStart + 2 * SIGNED_BROWSER_URL_BUCKET_MS
    );
    browserUrlCache.set(key, {
      url,
      until: bucketStart + SIGNED_BROWSER_URL_BUCKET_MS,
    });
    return url;
  } catch (e) {
    // Never fail the request over this — the caller falls back to proxying the
    // bytes, which is exactly what this deployment did before signing worked.
    console.warn(`browserMediaUrl: falling back to proxying ${key}:`, e?.message ?? e);
    return null;
  }
}

/**
 * How this deployment gets media to the browser right now. Surfaced on the
 * admin Status tab: `proxy` means every byte is still flowing through the
 * serverless function, which works but is the condition that times out under
 * load. Uses a key that is not user media, and signs nothing that is served.
 */
export async function mediaDeliveryMode()

 {
  const probeKey = "healthcheck/media-delivery-probe";
  const cdn = getMediaRedirectUrl(probeKey);
  if (cdn) {
    return { kind: "cdn", detail: process.env.GCP_MEDIA_CDN_URL ?? "GCP_MEDIA_CDN_URL" };
  }
  const now = Date.now();
  try {
    await signReadUrl(probeKey, now, now + 60_000);
    return {
      kind: "signed",
      detail: primaryIsGcs()
        ? `GCS V4 via IAM signBlob (${process.env.GCP_SERVICE_ACCOUNT_EMAIL ?? "runtime SA"})`
        : `S3 presigned (${legacyBucketName()})`,
    };
  } catch (e) {
    return { kind: "proxy", detail: e?.message ?? String(e) };
  }
}

/** Seconds a browser may reuse a `/api/media` redirect before re-minting it.
 * Kept just inside the bucket so a cached redirect can never outlive the URL
 * it points at. */
export const BROWSER_URL_REDIRECT_MAX_AGE_S = Math.floor(
  (SIGNED_BROWSER_URL_BUCKET_MS / 1000) * 0.75
);

/**
 * A provider-fetchable URL for a stored reference (`/api/media/...` or a CDN
 * URL). Returns null when the ref is not one of ours — an external URL is
 * already fetchable.
 *
 * Tries the cheapest mechanism that works, in order:
 *  1. cloud presigned URL (or the public CDN, inside getSignedReadUrl) — the
 *     cloud serves the bytes and we pay no egress;
 *  2. our own signed grant route, which always works because it depends on
 *     nothing but AUTH_SECRET.
 *
 * The fallback is not hypothetical: on GCS with Workload Identity Federation
 * there is no signing key, so step 1 cannot succeed — confirmed in production.
 * Falling back rather than failing means video-to-video works on either
 * backend, with or without a CDN, and gets faster for free if one is added.
 */
export async function signStoredRef(
  ref,
  ttlSeconds
) {
  const key = mediaKeyFromRef(ref);
  if (!key) return null;
  try {
    return await getSignedReadUrl(key, ttlSeconds);
  } catch (cloudError) {
    const { mediaGrantUrl } = await import("./media-grant");
    try {
      return mediaGrantUrl(key, ttlSeconds);
    } catch (grantError) {
      // Both routes failed — surface both reasons, since the fix differs.
      throw new Error(
        `${grantError?.message ?? grantError} (cloud signing also failed: ${
          cloudError?.message ?? cloudError
        })`
      );
    }
  }
}

export function getMediaRedirectUrl(key) {
  if (!primaryIsGcs()) return null;
  const base = process.env.GCP_MEDIA_CDN_URL?.replace(/\/$/, "");
  return base ? `${base}/${encodeKey(key)}` : null;
}

async function saveBuffer(
  buffer,
  key,
  contentType,
  cacheControl
) {
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

/**
 * Render and store the thumbnail ladder for one image.
 *
 * Every ladder step is written even when the source is narrower than the step —
 * `withoutEnlargement` means those are just a copy at native width. The few tens
 * of kB that wastes buys a flat invariant the read path can rely on: for a
 * thumbnailable key, every ladder derivative exists. The alternative (write only
 * the steps that shrink) makes "absent" mean either "small original" or "not
 * generated yet", and the read path cannot tell those apart.
 */
export async function writeThumbnails(buffer, key) {
  if (!isThumbnailable(key)) return;
  const sharp = (await import("sharp")).default;
  await Promise.all(
    THUMB_LADDER.map(async (width) => {
      const out = await sharp(buffer, { failOn: "error", sequentialRead: true })
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: 75 })
        .toBuffer();
      await saveBuffer(
        out,
        thumbKey(key, width),
        "image/webp",
        "public, max-age=31536000, immutable"
      );
    })
  );
}

/** Persist one already-rendered ladder derivative. Used by the read path when
 * it has to fill a gap the write path left. */
export async function saveThumbnailObject(
  out,
  originalKey,
  width
) {
  await saveBuffer(
    out,
    thumbKey(originalKey, width),
    "image/webp",
    "public, max-age=31536000, immutable"
  );
}

/** Upload media to the selected backend and return its stable compatibility URL. */
export async function uploadBuffer(
  buffer,
  key,
  ext
) {
  await saveBuffer(
    buffer,
    key,
    extToMime(ext),
    "public, max-age=31536000, immutable"
  );
  // Best-effort: a thumbnail that fails to render must never fail the
  // generation whose result this is. The read path regenerates on miss, so the
  // only cost of failing here is that one image's first view does the work.
  try {
    await writeThumbnails(buffer, key);
  } catch (e) {
    console.warn(`writeThumbnails failed for ${key}:`, e?.message ?? e);
  }
  return `/api/media/${key}`;
}

export async function writePrivateBuffer(
  buffer,
  key,
  contentType = "application/octet-stream"
) {
  await saveBuffer(buffer, key, contentType, "private, no-store");
}

export async function uploadBase64(
  base64,
  key,
  ext
) {
  return uploadBuffer(Buffer.from(base64, "base64"), key, ext);
}

const ALLOWED_DATA_URL_MIME_EXT = {
  jpeg: "jpg",
  jpg: "jpg",
  png: "png",
  webp: "webp",
  gif: "gif",
};

export function splitDataUrl(input) {
  const m = input.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.*)$/s);
  const subtype = m?.[1]?.toLowerCase();
  const ext = subtype ? ALLOWED_DATA_URL_MIME_EXT[subtype] : undefined;
  if (!m || !ext) {
    throw new Error("Unsupported image type. Use JPEG, PNG, WebP, or GIF.");
  }
  return { ext, data: m[2] };
}

export async function uploadFromUrl(
  url,
  key,
  ext,
  signal
) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Failed to download media (${res.status})`);
  return uploadBuffer(Buffer.from(await res.arrayBuffer()), key, ext);
}

async function readLegacyObject(
  key
) {
  const response = await legacyS3().send(
    new GetObjectCommand({ Bucket: legacyBucketName(), Key: key })
  );
  if (!response.Body) throw new Error("Legacy S3 object body is empty");
  return {
    buffer: Buffer.from(await response.Body.transformToByteArray()),
    contentType: response.ContentType || extToMime(key.split(".").pop() || "png"),
  };
}

async function readLegacyBuffer(key) {
  return (await readLegacyObject(key)).buffer;
}

export async function readStoredBuffer(key) {
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
  ref,
  signal
) {
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
    const res = await fetch(ref, { signal });
    if (!res.ok) throw new Error(`Failed to read media (${res.status})`);
    return {
      mimeType: res.headers.get("content-type") || "image/png",
      data: Buffer.from(await res.arrayBuffer()).toString("base64"),
    };
  }

  throw new Error(`Unsupported media reference format: ${ref}`);
}

/**
 * Positive existence cache for the read path's derivative lookup.
 *
 * Objects here are immutable and never deleted out from under a live key, so a
 * "yes" can be remembered for the life of the instance; a "no" is never cached,
 * because the very next thing the caller does about a miss is create the object.
 * Bounded so a long-lived warm instance can't grow without limit.
 */
const MAX_REMEMBERED_OBJECTS = 5000;
const knownObjects = new Set();

export async function objectExists(key) {
  if (knownObjects.has(key)) return true;
  let found;
  try {
    if (primaryIsGcs()) {
      const [exists] = await withOpenTimeout(
        storage().bucket(getBucketName()).file(key).exists(),
        `GCS exists ${key}`
      );
      found = exists;
    } else {
      await withOpenTimeout(
        legacyS3().send(
          new HeadObjectCommand({ Bucket: legacyBucketName(), Key: key })
        ),
        `S3 HeadObject ${key}`
      );
      found = true;
    }
  } catch (error) {
    if (isNotFound(error) || (error )?.name === "NotFound") {
      return false;
    }
    throw error;
  }
  if (found) {
    if (knownObjects.size >= MAX_REMEMBERED_OBJECTS) knownObjects.clear();
    knownObjects.add(key);
  }
  return found;
}

export class MediaNotFoundError extends Error {}
export class InvalidMediaRangeError extends Error {}

function parseRange(range, size) {
  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2]) || size <= 0) {
    throw new InvalidMediaRangeError();
  }
  let start;
  let end;
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

/**
 * Bound a cloud round-trip that has no timeout of its own.
 *
 * Neither the GCS client's metadata call nor an S3 GetObject will fail on a
 * stalled socket within any useful time, and `/api/media/[...path]` awaits them
 * before it can send a single byte. Without this a hung upstream read holds a
 * serverless invocation until the platform's own ceiling and surfaces to the
 * user as a 504 several minutes later — which is what the 2026-08-04 alert on
 * that route was. Failing in seconds turns that into a retryable 500 and gives
 * the concurrency slot back.
 */
const OPEN_MEDIA_TIMEOUT_MS = Number(process.env.MEDIA_OPEN_TIMEOUT_MS || 15_000);

async function withOpenTimeout(work, what) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} timed out after ${OPEN_MEDIA_TIMEOUT_MS}ms`)),
          OPEN_MEDIA_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function openLegacyMedia(
  key,
  range,
  signal
) {
  try {
    const response = await withOpenTimeout(
      legacyS3().send(
        new GetObjectCommand({ Bucket: legacyBucketName(), Key: key, Range: range }),
        { abortSignal: signal  }
      ),
      `S3 GetObject ${key}`
    );
    if (!response.Body) throw new MediaNotFoundError();
    return {
      stream: response.Body.transformToWebStream() ,
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

/**
 * `signal` is the inbound request's abort signal. It is load-bearing, not
 * defensive: a `<video>` element opens this route, reads the moov atom and
 * abandons the rest, and a feed of media cards aborts every request for a card
 * that scrolls out. Nothing tears the upstream read down on its own, so those
 * orphaned reads keep their invocation alive to the timeout ceiling.
 */
export async function openMediaObject(
  key,
  range,
  signal
) {
  if (!primaryIsGcs()) return openLegacyMedia(key, range, signal);
  try {
    const file = storage().bucket(getBucketName()).file(key);
    const [metadata] = await withOpenTimeout(
      file.getMetadata(),
      `GCS getMetadata ${key}`
    );
    const size = Number(metadata.size || 0);
    const parsed = range ? parseRange(range, size) : undefined;
    const nodeStream = file.createReadStream(
      parsed
        ? { start: parsed.start, end: parsed.end, validation: false }
        : { validation: false }
    );
    if (signal) {
      if (signal.aborted) nodeStream.destroy();
      else
        signal.addEventListener("abort", () => nodeStream.destroy(), {
          once: true,
        });
    }
    return {
      stream: Readable.toWeb(nodeStream) ,
      contentType: metadata.contentType || "application/octet-stream",
      contentLength: parsed ? parsed.end - parsed.start + 1 : size,
      contentRange: parsed ? `bytes ${parsed.start}-${parsed.end}/${size}` : undefined,
      status: parsed ? 206 : 200,
    };
  } catch (error) {
    if (!isNotFound(error)) throw error;
    if (!legacyReadsEnabled()) throw new MediaNotFoundError();

    return openLegacyMedia(key, range, signal);
  }
}

/**
 * Every user-media key in the active backend, excluding derivatives and the
 * protected prefixes. For maintenance scripts (the thumbnail backfill) — the
 * request path never lists.
 */
export async function listMediaKeys() {
  const keep = (key) =>
    !key.startsWith(THUMB_PREFIX) && !isProtectedMediaKey(key) && !key.endsWith("/");

  if (primaryIsGcs()) {
    const [files] = await storage().bucket(getBucketName()).getFiles();
    return files.map((f) => f.name).filter(keep);
  }

  const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
  const out = [];
  let token;
  do {
    const page = await legacyS3().send(
      new ListObjectsV2Command({
        Bucket: legacyBucketName(),
        ContinuationToken: token,
      })
    );
    for (const o of page.Contents ?? []) if (o.Key && keep(o.Key)) out.push(o.Key);
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return out;
}

export async function deleteByUrls(urls) {
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

export async function checkStorageConnectivity() {
  if (!primaryIsGcs()) {
    await legacyS3().send(new HeadBucketCommand({ Bucket: legacyBucketName() }));
    return `S3 bucket ${legacyBucketName()}`;
  }
  const [exists] = await storage().bucket(getBucketName()).exists();
  if (!exists) throw new Error(`GCS bucket ${getBucketName()} does not exist`);
  return `GCS bucket ${getBucketName()}`;
}

export async function ensureBucket() {
  await checkStorageConnectivity();
}
