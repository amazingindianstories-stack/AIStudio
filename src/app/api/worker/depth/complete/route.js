import { NextResponse } from "next/server";
import { verifyWorkerToken } from "@/lib/depth-worker-auth";
import { completeDepthJob } from "@/lib/depth-jobs-db";
import { logActivity } from "@/lib/activity";

export const runtime = "nodejs";

/**
 * Called once after upload-url + the direct PUT to storage finished (success)
 * or once processing failed outright (no upload happened). `key` is the raw
 * storage key from /upload-url — this route is what turns that into the
 * `/api/media/...` ref every other kind's `url` column already uses, so the
 * feed/history/download-zip code paths need no depth-specific case.
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

  if (body.ok === true) {
    const key = (body.key || "").trim();
    if (!key) {
      return NextResponse.json({ error: "key is required when ok=true." }, { status: 400 });
    }
    await completeDepthJob(jobId, {
      ok: true,
      url: `/api/media/${key}`,
      aspectRatio: typeof body.aspectRatio === "string" ? body.aspectRatio : undefined,
    });
    await logActivity(null, "depth_complete", { id: jobId });
  } else {
    await completeDepthJob(jobId, {
      ok: false,
      error: typeof body.error === "string" ? body.error.slice(0, 2000) : "Depth worker reported failure.",
    });
    await logActivity(null, "depth_failed", { id: jobId, error: body.error });
  }

  return NextResponse.json({ ok: true });
}
