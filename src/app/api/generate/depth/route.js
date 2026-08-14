import { NextResponse } from "next/server";
import { upsertItem } from "@/lib/store-db";
import { getSession } from "@/lib/auth";
import { logActivity } from "@/lib/activity";
import { DEPTH_MODEL_NAME, DEPTH_ENCODERS } from "@/lib/config";

export const runtime = "nodejs";

/**
 * Enqueue-only, same shape as generate/image and generate/video — but unlike
 * those, nothing here ever calls a provider. This row just sits at
 * status='queued' until the local worker's own claim loop picks it up (see
 * /api/worker/depth/claim); there is no /api/queue/execute equivalent for
 * depth jobs; that route's whole reason to exist is admission control for
 * the shared per-kind concurrency cap and Gemini's spend window, neither of
 * which applies to a job that runs on hardware this app doesn't pay for or
 * share capacity on.
 *
 * The input video must already be uploaded (see /api/uploads/presign) —
 * `inputVideoKey` is the storage key that returned, not raw bytes.
 */
export async function POST(req) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const inputVideoKey = (body.inputVideoKey || "").trim();
  const encoder = DEPTH_ENCODERS.includes(body.encoder) ? body.encoder : "vitb";
  const trackCharacters = body.trackCharacters === true;
  const projectId = body.projectId || undefined;
  const folderId = body.folderId || undefined;
  const originalName = typeof body.originalName === "string" ? body.originalName.slice(0, 200) : "";

  if (!inputVideoKey) {
    return NextResponse.json({ error: "An input video is required." }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const base = {
    id,
    kind: "depth",
    status: "queued",
    // Descriptive only — depth jobs have no user-authored prompt, but the
    // column is NOT NULL and the feed/search UI reads it as the row's label.
    prompt: originalName ? `Depth map: ${originalName}` : "Depth map",
    model: DEPTH_MODEL_NAME,
    aspectRatio: "16:9", // placeholder — corrected to the measured output ratio on completion, same pattern as Kling image-to-image (see providers/kling.js)
    // Encoder choice rides in `resolution` — see the comment on
    // /api/worker/depth/claim that reads it back out.
    resolution: encoder,
    trackCharacters,
    referenceVideos: [inputVideoKey],
    projectId,
    folderId,
    userId: user.id,
    costCents: 0, // runs on local hardware this app doesn't pay cloud rates for
    createdAt: now,
    updatedAt: now,
  };

  try {
    await upsertItem(base);
    await logActivity(user.id, "generate", { id, kind: "depth", model: DEPTH_MODEL_NAME, costCents: 0 });
    return NextResponse.json(base);
  } catch (e) {
    return NextResponse.json(
      { error: e?.message || "Failed to save the generation request." },
      { status: 500 }
    );
  }
}
