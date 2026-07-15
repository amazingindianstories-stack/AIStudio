import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  getMediaRedirectUrl,
  InvalidMediaRangeError,
  MediaNotFoundError,
  openMediaObject,
} from "@/lib/storage";

export const runtime = "nodejs";

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
  if (!(await getSession())) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const key = (await params).path.join("/");
  if (FORBIDDEN_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const cdnUrl = getMediaRedirectUrl(key);

  // Preserve every existing /api/media URL while moving the bytes off Vercel.
  // Browsers forward Range headers across this temporary redirect to Cloud CDN.
  if (cdnUrl) return NextResponse.redirect(cdnUrl, 307);

  try {
    const media = await openMediaObject(
      key,
      request.headers.get("range") ?? undefined
    );
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
