import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getSession, verifySessionToken, SESSION_COOKIE } from "../../../../../lib/auth.js";
import { getDb } from "../../../../../lib/db.js";
import { generations } from "../../../../../lib/schema.js";
import { batchResolveGenerationFilenames } from "../../../../../lib/filename-resolver.js";
import {
  openMediaObject,
  mediaKeyFromRef,
  isProtectedMediaKey,
  getSignedDownloadUrl,
  MediaNotFoundError,
  InvalidMediaRangeError,
} from "../../../../../lib/storage.js";

export const runtime = "nodejs";
export const maxDuration = 120;

async function authenticate(request) {
  const session = await getSession();
  if (session?.user) return session.user;

  const cookieHeader = request.headers?.get?.("cookie");
  let cookieVal = null;
  if (cookieHeader) {
    const parts = cookieHeader.split(";");
    for (const part of parts) {
      const [k, v] = part.trim().split("=");
      if (k === SESSION_COOKIE) {
        cookieVal = v;
        break;
      }
    }
  }

  const token = request.cookies?.get?.(SESSION_COOKIE)?.value || cookieVal;
  if (token) {
    const verified = verifySessionToken(token);
    if (verified) return { id: verified.userId };
  }
  return null;
}

export async function GET(request, { params }, options = {}) {
  return handleDownload(request, params, false, options);
}

export async function HEAD(request, { params }, options = {}) {
  return handleDownload(request, params, true, options);
}

export async function handleDownload(request, rawParams, isHead = false, options = {}) {
  const user = await authenticate(request);
  if (!user) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const { id } = await rawParams;
  if (!id) {
    return NextResponse.json({ error: "INVALID_GENERATION_ID" }, { status: 400 });
  }

  const db = await getDb();
  const [gen] = await db
    .select()
    .from(generations)
    .where(eq(generations.id, id))
    .limit(1);

  if (!gen) {
    return NextResponse.json({ error: "GENERATION_NOT_FOUND" }, { status: 404 });
  }

  if (gen.status === "pending" || gen.status === "running") {
    return NextResponse.json(
      { error: "GENERATION_PROCESSING", message: "Generation is still processing." },
      { status: 409 }
    );
  }

  if (gen.status === "failed") {
    return NextResponse.json(
      { error: "GENERATION_FAILED", message: "Cannot download a failed generation." },
      { status: 409 }
    );
  }

  if (!gen.url) {
    return NextResponse.json(
      { error: "MEDIA_NOT_FOUND", message: "Generation has no media output." },
      { status: 404 }
    );
  }

  const key = mediaKeyFromRef(gen.url);
  if (!key || isProtectedMediaKey(key)) {
    return NextResponse.json(
      { error: "MEDIA_NOT_FOUND", message: "Media key is unavailable or protected." },
      { status: 404 }
    );
  }

  // Resolve canonical hierarchical filename
  const filenameMap = await batchResolveGenerationFilenames(db, [gen.id]);
  const resolved = filenameMap.get(gen.id);
  const filename = resolved?.filename || `${gen.id}.bin`;

  // RFC 6266 Content-Disposition header with safe ASCII fallback and full UTF-8 specification
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "");
  const disposition = `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;

  const urlObj = new URL(request.url, "http://localhost");
  const preferSigned = urlObj.searchParams.get("signed") === "1" || urlObj.searchParams.get("redirect") === "1";

  if (preferSigned && !request.headers.get("range")) {
    const signFn = options.getSignedDownloadUrl || getSignedDownloadUrl;
    const signedUrl = await signFn(key, { filename, disposition }).catch(() => null);
    if (signedUrl) {
      return NextResponse.redirect(signedUrl, { status: 307 });
    }
  }

  try {
    const openFn = options.openMediaObject || openMediaObject;
    const media = await openFn(
      key,
      request.headers.get("range") ?? undefined,
      request.signal
    );

    const headers = {
      "Content-Type": media.contentType,
      "Content-Length": String(media.contentLength),
      "Content-Disposition": disposition,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-cache, no-store, must-revalidate",
      "X-Content-Type-Options": "nosniff",
    };

    if (media.contentRange) {
      headers["Content-Range"] = media.contentRange;
    }

    if (isHead) {
      return new NextResponse(null, { status: media.status, headers });
    }

    return new NextResponse(media.stream, { status: media.status, headers });
  } catch (error) {
    if (error instanceof MediaNotFoundError) {
      return NextResponse.json({ error: "MEDIA_NOT_FOUND" }, { status: 404 });
    }
    if (error instanceof InvalidMediaRangeError) {
      return new NextResponse("Range Not Satisfiable", { status: 416 });
    }
    if (request.signal?.aborted) {
      return new NextResponse(null, { status: 499 });
    }
    console.error("Direct download stream error:", error);
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
