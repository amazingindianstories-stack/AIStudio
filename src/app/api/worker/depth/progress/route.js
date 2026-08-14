import { NextResponse } from "next/server";
import { verifyWorkerToken } from "@/lib/depth-worker-auth";
import { reportDepthProgress } from "@/lib/depth-jobs-db";

export const runtime = "nodejs";

/** Worker calls this periodically while processing a claimed job — this is
 *  the "how much of a video has been generated" status message the composer
 *  shows, e.g. "Processing frame 812/1900 (43%)". */
export async function POST(req) {
  if (!verifyWorkerToken(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const jobId = (body.jobId || "").trim();
  const percent = Number(body.percent);
  if (!jobId || !Number.isFinite(percent)) {
    return NextResponse.json({ error: "jobId and a numeric percent are required." }, { status: 400 });
  }
  await reportDepthProgress(jobId, percent, typeof body.message === "string" ? body.message.slice(0, 300) : undefined);
  return NextResponse.json({ ok: true });
}
