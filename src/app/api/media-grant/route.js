import { NextResponse } from "next/server";
import {
  MediaNotFoundError,
  InvalidMediaRangeError,
  openMediaObject,
} from "@/lib/storage";
import { verifyMediaGrant } from "@/lib/media-grant";

export const runtime = "nodejs";

/**
 * Serve ONE stored object to a bearer of a short-lived signed grant.
 *
 * Deliberately session-free: this exists so an external provider (BytePlus
 * fetching a `video_url`) can read a clip, which `/api/media/[...path]` refuses
 * by design. The grant token is the credential — see lib/media-grant.ts for why
 * this route exists rather than a cloud presigned URL, and for the limits that
 * make it narrower than making the bucket public.
 *
 * The path is NOT taken from the URL. It comes out of the signed token, so a
 * caller cannot point this at a different object by editing the querystring —
 * which is the whole difference between this and the unauthenticated media
 * route that had to be fixed in 2026-07-15.
 */
export async function GET(req) {
  const key = verifyMediaGrant(req.nextUrl.searchParams.get("t"));
  if (!key) {
    // One message for malformed, tampered and expired alike — distinguishing
    // them would tell a prober which part of the token to attack.
    return NextResponse.json({ error: "INVALID_OR_EXPIRED_GRANT" }, { status: 403 });
  }

  try {
    const media = await openMediaObject(key, req.headers.get("range") ?? undefined);
    const headers = new Headers({
      "Content-Type": media.contentType,
      "Content-Length": String(media.contentLength),
      // Same defence-in-depth as the media route: never let a stored object be
      // sniffed into something executable.
      "X-Content-Type-Options": "nosniff",
      // Private and short-lived, matching the grant itself. A shared cache
      // must not keep this after the token dies.
      "Cache-Control": "private, max-age=300",
      "Accept-Ranges": "bytes",
    });
    if (media.contentRange) headers.set("Content-Range", media.contentRange);
    return new NextResponse(media.stream, { status: media.status, headers });
  } catch (error) {
    if (error instanceof MediaNotFoundError) {
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    }
    if (error instanceof InvalidMediaRangeError) {
      return NextResponse.json({ error: "INVALID_RANGE" }, { status: 416 });
    }
    console.error("[media-grant] failed to serve", key, error);
    return NextResponse.json({ error: "READ_FAILED" }, { status: 500 });
  }
}
