import { NextResponse } from "next/server";
import { verifyWorkerToken } from "@/lib/depth-worker-auth";
import { claimNextDepthJob, completeDepthJob } from "@/lib/depth-jobs-db";
import { getSignedReadUrl } from "@/lib/storage";

export const runtime = "nodejs";

/**
 * The worker polls this (long-poll-free — it's cheap, and a plain short
 * interval is simpler to reason about than a hanging request that a laptop
 * sleep/wake cycle would leave in a bad state) to pull the next queued depth
 * job. Returns `{ job: null }` when the queue is empty, not a 404 — an empty
 * queue is the expected steady state, not an error.
 *
 * The claim itself (claimNextDepthJob) is the atomic step; this route's own
 * job is just to hand back a URL the worker can actually download the input
 * video from, since referenceVideos stores a raw storage key, not a
 * fetchable URL.
 *
 * Uses `getSignedReadUrl` directly rather than `signStoredRef` (which
 * `queue/execute` uses to hand BytePlus a provider-fetchable URL) —
 * `signStoredRef` exists to disambiguate a ref that could be either an
 * `/api/media/...` path or a CDN URL, silently returning `null` for
 * anything else. A depth job's `referenceVideos[0]` is always already a
 * bare storage key (see generate/depth/route.js's own comment on
 * `inputVideoKey`), never wrapped in either of those forms, so it isn't the
 * ambiguous case that function handles — and going through it meant a
 * `null` return became `inputVideoUrl: null` in a job the worker otherwise
 * treated as claimable, which surfaced client-side as Python's
 * `requests` choking on a `None` URL rather than a clean job failure.
 */
export async function POST(req) {
  if (!verifyWorkerToken(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const workerId = (body.workerId || "").trim();
  if (!workerId) {
    return NextResponse.json({ error: "workerId is required." }, { status: 400 });
  }

  const job = await claimNextDepthJob(workerId);
  if (!job) return NextResponse.json({ job: null });
  // The encoder choice (vits/vitb/vitl) rides in the `resolution` column —
  // there's no dedicated column for it, and it plays the same "which quality
  // tier" role resolution plays for image/video, so it's a reuse rather than
  // a new single-purpose field for one value.

  const inputRef = Array.isArray(job.referenceVideos) ? job.referenceVideos[0] : undefined;
  if (!inputRef) {
    // Shouldn't happen (the enqueue route requires an input video), but a
    // job with nothing to process can't be handed to the worker as if it
    // could — fail it now rather than silently wedging.
    await completeDepthJob(job.id, { ok: false, error: "No input video was attached to this job." });
    return NextResponse.json({ job: null });
  }

  let inputVideoUrl;
  try {
    inputVideoUrl = await getSignedReadUrl(inputRef, 30 * 60);
  } catch (e) {
    await completeDepthJob(job.id, {
      ok: false,
      error: `Could not produce a download URL for the input video: ${e?.message ?? e}`,
    });
    return NextResponse.json({ job: null });
  }

  return NextResponse.json({
    job: {
      id: job.id,
      inputVideoUrl,
      encoder: job.encoder ?? "vitb",
      // YOLOv8-seg person tracking composited onto the depth map — see
      // schema.js's trackCharacters comment for what this branches to
      // worker-side (color_code_depth.py's approach) vs. a plain depth pass.
      trackCharacters: job.trackCharacters === true,
    },
  });
}
