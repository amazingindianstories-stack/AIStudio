import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getSession } from "@/lib/auth";
import { getSignedUploadUrl } from "@/lib/storage";

export const runtime = "nodejs";

/**
 * General-purpose presigned-upload endpoint: returns a URL the browser can
 * PUT a file to directly, for uploads too large to inline as base64 in a
 * request body (Vercel's 4.5MB limit — see getSignedUploadUrl's docstring).
 * First (and currently only) caller is the depth-map composer's input-video
 * upload; every existing upload path (reference images, avatars, canvas
 * assets) stays on the base64-in-body route because those are downscaled
 * client-side to fit under the limit already (see PromptComposer.jsx's
 * budget ladder) — a raw video has no equivalent downscale step.
 *
 * `purpose` namespaces the storage key so different upload kinds don't
 * collide and so the protected-prefix denylist in storage.js still applies
 * uniformly (isProtectedMediaKey is checked inside getSignedUploadUrl).
 */
const ALLOWED_PURPOSES = {
  "depth-input": { prefix: "uploads/depth-input", contentTypes: [/^video\//] },
};

export async function POST(req) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const purpose = ALLOWED_PURPOSES[body.purpose];
  if (!purpose) {
    return NextResponse.json(
      { error: `Unknown upload purpose (expected one of: ${Object.keys(ALLOWED_PURPOSES).join(", ")}).` },
      { status: 400 }
    );
  }
  const contentType = typeof body.contentType === "string" ? body.contentType : "";
  if (!purpose.contentTypes.some((re) => re.test(contentType))) {
    return NextResponse.json(
      { error: `${body.purpose} does not accept content type "${contentType}".` },
      { status: 400 }
    );
  }

  const key = `${purpose.prefix}/${user.id}-${randomUUID()}`;
  try {
    const uploadUrl = await getSignedUploadUrl(key, contentType);
    return NextResponse.json({ key, uploadUrl });
  } catch (e) {
    return NextResponse.json(
      { error: e?.message || "Failed to create an upload URL." },
      { status: 500 }
    );
  }
}
