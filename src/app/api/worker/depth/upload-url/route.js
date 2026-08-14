import { NextResponse } from "next/server";
import { verifyWorkerToken } from "@/lib/depth-worker-auth";
import { getSignedUploadUrl } from "@/lib/storage";

export const runtime = "nodejs";

/**
 * The worker calls this once its output video exists locally, then PUTs the
 * file directly to the returned URL — the same reasoning as
 * getSignedUploadUrl's own docstring: a finished depth-map video is well
 * over Vercel's 4.5MB body limit, so it cannot be POSTed to a route body the
 * way image references are.
 */
export async function POST(req) {
  if (!verifyWorkerToken(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const jobId = (body.jobId || "").trim();
  if (!jobId) {
    return NextResponse.json({ error: "jobId is required." }, { status: 400 });
  }
  const key = `depth-output/${jobId}.mp4`;
  try {
    const uploadUrl = await getSignedUploadUrl(key, "video/mp4");
    return NextResponse.json({ key, uploadUrl });
  } catch (e) {
    return NextResponse.json(
      { error: e?.message || "Failed to create an upload URL." },
      { status: 500 }
    );
  }
}
