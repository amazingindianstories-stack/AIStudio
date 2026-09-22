import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getSignedUploadUrl } from "@/lib/storage";
import { createUploadPresign } from "@/lib/upload-presign";

export const runtime = "nodejs";

/**
 * General-purpose presigned-upload endpoint: returns a URL the browser can
 * PUT a file to directly, for uploads too large to inline as base64 in a
 * request body (Vercel's 4.5MB limit — see getSignedUploadUrl's docstring).
 * Used by reference-image, audio-reference, and depth-video uploads. Other
 * small image paths (avatars and canvas assets) remain on their existing
 * base64-in-body routes.
 *
 * `purpose` namespaces the storage key so different upload kinds don't
 * collide and so the protected-prefix denylist in storage.js still applies
 * uniformly (isProtectedMediaKey is checked inside getSignedUploadUrl).
 */
export async function POST(req) {
  const user = await getSession();
  const body = await req.json().catch(() => ({}));
  const result = await createUploadPresign(
    { userId: user?.id, purpose: body.purpose, contentType: body.contentType },
    { signUploadUrl: getSignedUploadUrl }
  );
  return NextResponse.json(result.body, { status: result.status });
}
