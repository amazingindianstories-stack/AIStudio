import { NextRequest, NextResponse } from "next/server";
import { Readable } from "node:stream";
import sharp from "sharp";
import {
  SESSION_COOKIE,
  verifySessionToken,
} from "@/lib/auth";
import {
  getMediaRedirectUrl,
  InvalidMediaRangeError,
  MediaNotFoundError,
  openMediaObject,
} from "@/lib/storage";

export const runtime = "nodejs";

// Thumbnail width bounds for the `?w=` resize param — grid/feed cards and
// canvas nodes request a small width instead of downloading the full-res
// original; clamped so the endpoint can't be used to force arbitrarily
// large sharp jobs.
const MIN_THUMB_WIDTH = 32;
const MAX_THUMB_WIDTH = 1600;

function parseThumbWidth(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(Math.min(MAX_THUMB_WIDTH, Math.max(MIN_THUMB_WIDTH, n)));
}

/** Resize an image stream to `width` and re-encode as webp. Buffers the
 * (small) output only — the source is piped through sharp, not held whole
 * in memory. */
function resizeToWebp(stream: ReadableStream<Uint8Array>, width: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const source = Readable.fromWeb(stream as any);
    const transformer = sharp().resize({ width, withoutEnlargement: true }).webp({ quality: 75 });
    const chunks: Buffer[] = [];
    source.on("error", reject);
    transformer.on("error", reject);
    transformer.on("data", (chunk) => chunks.push(chunk as Buffer));
    transformer.on("end", () => resolve(Buffer.concat(chunks)));
    source.pipe(transformer);
  });
}

// Key prefixes that live in the same bucket as user media but are never
// "media" — settings blobs (e.g. the Higgsfield MCP OAuth token) and
// Postgres migration snapshots. The signed-in check below is the primary
// fix (this route previously had NO auth check at all — middleware.ts only
// verifies a session cookie is *present*, not validly signed, so any
// request with a garbage cookie value could read any object in the
// bucket). This denylist is defense-in-depth on top of that: these
// prefixes hold secrets/PII that no ordinary signed-in user should be able
// to fetch just because "media serving" happens to share their bucket.
const FORBIDDEN_KEY_PREFIXES = ["settings/", "migrations/"];

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
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
  if (FORBIDDEN_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const width = parseThumbWidth(request.nextUrl.searchParams.get("w"));

  // Thumbnail requests need the bytes back through this function to resize
  // them, so they can't take the CDN-redirect shortcut below.
  if (!width) {
    const cdnUrl = getMediaRedirectUrl(key);
    // Preserve every existing /api/media URL while moving the bytes off Vercel.
    // Browsers forward Range headers across this temporary redirect to Cloud CDN.
    if (cdnUrl) return NextResponse.redirect(cdnUrl, 307);
  }

  try {
    const media = await openMediaObject(
      key,
      width ? undefined : request.headers.get("range") ?? undefined
    );

    if (width && media.contentType.startsWith("image/")) {
      const resized = await resizeToWebp(media.stream, width);
      return new NextResponse(new Uint8Array(resized), {
        status: 200,
        headers: {
          "Content-Type": "image/webp",
          "Content-Length": String(resized.length),
          "Cache-Control": "public, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    const headers: Record<string, string> = {
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
    console.error("Error serving media:", error);
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}
