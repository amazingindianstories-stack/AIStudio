import { NextResponse } from "next/server";
import { Readable } from "node:stream";
import sharp from "sharp";
import {
  SESSION_COOKIE,
  verifySessionToken,
} from "@/lib/auth";
import {
  browserMediaUrl,
  BROWSER_URL_REDIRECT_MAX_AGE_S,
  InvalidMediaRangeError,
  isProtectedMediaKey,
  MediaNotFoundError,
  objectExists,
  openMediaObject,
  saveThumbnailObject,
} from "@/lib/storage";
import { isThumbnailable, thumbKey, thumbLadderWidth } from "@/lib/media-derivatives";

export const runtime = "nodejs";

// Every media byte in this deployment is proxied through this function: there
// is no GCP_MEDIA_CDN_URL configured, and GCS under Workload Identity
// Federation has no signing key, so there is nothing to redirect a browser to
// (see storage.ts). That makes this the single hottest route in the app and the
// only one whose work is bounded by the *client* rather than by us.
//
// Without an explicit value it inherits `functionDefaultTimeout: 300`, so a
// stalled upstream read or an abandoned <video> connection burned five minutes
// of a concurrency slot and then returned a 504 — the 2026-08-04 Vercel alert.
// The real fix is to stop proxying bytes at all; until then this is the
// backstop, deliberately generous enough for a large clip on a slow connection
// (120s ≈ 20 MB at 1.3 Mbps) while still being far below the ceiling. The thing
// that actually frees stuck slots promptly is the abort propagation below.
export const maxDuration = 120;

// Thumbnail width bounds for the `?w=` resize param — grid/feed cards and
// canvas nodes request a small width instead of downloading the full-res
// original; clamped so the endpoint can't be used to force arbitrarily
// large sharp jobs.
const MIN_THUMB_WIDTH = 32;
const MAX_THUMB_WIDTH = 1600;

function parseThumbWidth(raw) {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(Math.min(MAX_THUMB_WIDTH, Math.max(MIN_THUMB_WIDTH, n)));
}

/**
 * Fill a missing ladder derivative: read the original, resize, persist, return
 * the bytes. Null if it can't be rendered, in which case the caller serves the
 * original — a large image is a better answer than a broken one.
 *
 * This is the only path that still runs sharp on a read, and it runs at most
 * once per (object, width) for the whole deployment.
 */
async function renderThumbnail(
  key,
  width,
  signal
) {
  try {
    const source = await openMediaObject(key, undefined, signal);
    if (!source.contentType.startsWith("image/")) return null;
    const out = await resizeToWebp(source.stream, width, signal);
    await saveThumbnailObject(out, key, width);
    return out;
  } catch (error) {
    if (error instanceof ClientGoneError) throw error;
    if (error instanceof MediaNotFoundError) throw error;
    console.warn(`renderThumbnail failed for ${key} @${width}:`, error);
    return null;
  }
}

/** Resize an image stream to `width` and re-encode as webp. Buffers the
 * (small) output only — the source is piped through sharp, not held whole
 * in memory.
 *
 * A card that scrolls out of the feed aborts its thumbnail request; finishing
 * the decode for a response nobody will read spends CPU that the requests still
 * on screen are contending for, on an instance they share (fluid compute). */
function resizeToWebp(
  stream,
  width,
  signal
) {
  return new Promise((resolve, reject) => {
    const source = Readable.fromWeb(stream );
    const transformer = sharp().resize({ width, withoutEnlargement: true }).webp({ quality: 75 });
    const chunks = [];
    const abort = () => {
      source.destroy();
      transformer.destroy();
      reject(new ClientGoneError());
    };
    if (signal) {
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
    }
    source.on("error", reject);
    transformer.on("error", reject);
    transformer.on("data", (chunk) => chunks.push(chunk ));
    transformer.on("end", () => resolve(Buffer.concat(chunks)));
    source.pipe(transformer);
  });
}

/** The client hung up mid-request. Not an error worth logging — it is the
 * normal outcome of scrolling a media feed. */
class ClientGoneError extends Error {}

// Key prefixes that live in the same bucket as user media but are never
// "media" — settings blobs (e.g. the Higgsfield MCP OAuth token) and
// Postgres migration snapshots. The signed-in check below is the primary
// fix (this route previously had NO auth check at all — middleware.ts only
// verifies a session cookie is *present*, not validly signed, so any
// request with a garbage cookie value could read any object in the
// bucket). This denylist is defense-in-depth on top of that: these
// prefixes hold secrets/PII that no ordinary signed-in user should be able
// to fetch just because "media serving" happens to share their bucket.
//
// `isProtectedMediaKey` (storage.ts) is the shared test — it also sees through
// the `thumbs/<width>/<original key>` namespace, which would otherwise let a
// request name a protected object under an allowed prefix.

export async function GET(
  request,
  { params }
) {
  // Media-heavy boards can issue dozens of requests together. The signed,
  // expiring cookie is sufficient for this read-only path and avoids exhausting
  // PostgreSQL by performing a user lookup for every thumbnail. All mutable and
  // privileged routes continue to use the database-backed getSession().
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token || !verifySessionToken(token)) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const key = (await params).path.join("/");
  if (isProtectedMediaKey(key)) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const width = parseThumbWidth(request.nextUrl.searchParams.get("w"));

  try {
    // Resolve which stored object actually answers this request: a `?w=` on an
    // image is served by a pre-rendered ladder derivative, everything else by
    // the object itself. `fresh` is set only when we had to render one here,
    // in which case we already hold the bytes.
    let target = key;
    let fresh = null;
    const step = width && isThumbnailable(key) ? thumbLadderWidth(width) : null;
    if (step) {
      const derivative = thumbKey(key, step);
      try {
        if (await objectExists(derivative)) {
          target = derivative;
        } else {
          // Miss: an object written before the ladder existed, or one whose
          // write-path render failed. Render it once, persist it, and every
          // later request for it is a redirect.
          fresh = await renderThumbnail(key, step, request.signal);
          if (fresh) target = derivative;
        }
      } catch (error) {
        if (error instanceof ClientGoneError || error instanceof MediaNotFoundError) {
          throw error;
        }
        // The derivative is an optimisation. A blip reaching it must degrade to
        // serving the original — larger, but correct — not to a 500 on every
        // card in the grid.
        console.warn(`thumbnail lookup failed for ${key} @${step}:`, error);
      }
    }

    // Hand the bytes to the browser directly whenever this deployment can
    // produce a URL for them — a CDN URL, or a signed one. This is the whole
    // point: media stops flowing through the function.
    //
    // `?inline=1` opts out, for the callers that need the response to be
    // same-origin: fetch-to-blob, canvas frame extraction and `<a download>`
    // all break across an origin boundary. See `inlineMediaUrl` in utils.ts.
    const inline = request.nextUrl.searchParams.get("inline") === "1";
    const direct = inline ? null : await browserMediaUrl(target);
    if (direct) {
      return NextResponse.redirect(direct, {
        status: 307,
        headers: {
          // `private` because this redirect is the auth-gated part. A shared
          // cache holding it would serve the signed URL to anyone.
          "Cache-Control": `private, max-age=${BROWSER_URL_REDIRECT_MAX_AGE_S}`,
        },
      });
    }

    // No CDN and no signing available: fall back to proxying, which is what
    // this route did for everything before.
    if (fresh) {
      return new NextResponse(new Uint8Array(fresh), {
        status: 200,
        headers: {
          "Content-Type": "image/webp",
          "Content-Length": String(fresh.length),
          "Cache-Control": "public, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    const media = await openMediaObject(
      target,
      request.headers.get("range") ?? undefined,
      request.signal
    );

    const headers = {
      "Content-Type": media.contentType,
      "Content-Length": String(media.contentLength),
      "Cache-Control": "public, max-age=31536000, immutable",
      "Accept-Ranges": "bytes",
      "X-Content-Type-Options": "nosniff",
    };
    if (media.contentRange) headers["Content-Range"] = media.contentRange;
    return new NextResponse(media.stream, { status: media.status, headers });
  } catch (error) {
    if (error instanceof MediaNotFoundError) {
      return new NextResponse("Not Found", { status: 404 });
    }
    if (error instanceof InvalidMediaRangeError) {
      return new NextResponse("Range Not Satisfiable", { status: 416 });
    }
    if (error instanceof ClientGoneError || request.signal.aborted) {
      // 499-style: nobody is listening. Returning rather than throwing keeps
      // these out of the route's error rate, which is what the 5xx alert
      // watches.
      return new NextResponse(null, { status: 499 });
    }
    console.error("Error serving media:", error);
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}
