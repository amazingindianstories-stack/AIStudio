import { NextResponse } from "next/server";
import { saveReferenceImages } from "@/lib/save-media";
import { upsertItem } from "@/lib/store-db";
import { getSession } from "@/lib/auth";
import { readPricing } from "@/lib/pricing-db";
import { computeCostCents } from "@/lib/pricing";
import { readEffectiveLimit } from "@/lib/limits-db";
import { logActivity } from "@/lib/activity";
import {
  aspectRatiosForModel,
  durationsForModel,
  durationRangeForModel,
  resolutionsForModel,
  supportsAudio,
  supportsFirstFrameContinuation,
  supportsSeed,
  supportsVideoReference,
  supportsVideoEditExtend,
  VIDEO_TASK_MODES,
  MAX_REFERENCE_VIDEOS,

} from "@/lib/config";
import { isOmniModel } from "@/lib/providers/omni";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Enqueue-only (mirrors the image route): creates the `queued` row and
 * returns it. The client polls /api/queue/status and calls
 * /api/queue/execute when it reaches the front — that route owns provider
 * submission, so concurrent load stays inside the per-kind caps.
 */
export async function POST(req) {
  // Fetched up front (not just where it was previously used, deeper in this
  // function) so the per-user prompt-length override below has it — this
  // route allows anonymous requests, so getSession() returning undefined
  // here is expected, not an error; readEffectiveLimit falls back to the
  // global default when there's no user to look an override up on.
  const user = await getSession();
  const body = await req.json().catch(() => ({}));
  const prompt = (body.prompt || "").trim();
  const aspectRatio = body.aspectRatio || "16:9";
  const resolution = body.resolution || "1080p";
  const model = body.model || "Higgsfield Seedance 2.0";
  const referenceImages = body.referenceImages;
  const projectId = body.projectId || undefined;
  const folderId = body.folderId || undefined;
  // Only honoured where the provider actually has the field. Silently ignoring
  // it elsewhere beats storing a true that nothing will ever act on, which
  // would read back as "this video has audio" on a path that cannot produce it.
  const generateAudio = body.generateAudio === true && supportsAudio(model);
  // Clips already in the library, referenced by their stored path. Dropped for
  // models with no video-reference field rather than persisted and ignored.
  const referenceVideos = supportsVideoReference(model)
    ? (Array.isArray(body.referenceVideos) ? body.referenceVideos : [])
        .filter((v) => typeof v === "string" && v.length > 0)
        .slice(0, MAX_REFERENCE_VIDEOS)
    : [];
  // Seedance 2.5 only — Edit/Extend an attached clip instead of ordinary
  // generation. Anything unrecognized falls back to "generate" rather than
  // 400ing, since this field didn't exist before this model shipped.
  const videoTaskMode = VIDEO_TASK_MODES.includes(body.videoTaskMode)
    ? body.videoTaskMode
    : "generate";
  // Edit forces duration to "match the source" at the provider layer
  // regardless of what's requested (providers/seedance.ts), so defaulting a
  // missing value to 5 here — right, for every other mode — would store a
  // number that was never actually asked for. undefined stays undefined.
  const duration =
    videoTaskMode === "edit" ? body.duration || undefined : body.duration || 5;
  // "Regenerate with same seed" (Phase 3.1) — native BytePlus Seedance only;
  // see supportsSeed's doc comment for why Omni/Higgsfield/Kling are excluded.
  // Dropped silently for unsupported models, same convention generateAudio
  // uses just above.
  const seed = supportsSeed(model) && Number.isInteger(body.seed) ? body.seed : undefined;
  // Multi-shot chaining (Phase 3.3) — "Continue this shot" hands over a data
  // URL of a frame extracted from a previous generation. Same gate/drop
  // convention as generateAudio/seed above: honoured only where
  // config.supportsFirstFrameContinuation confirms the model has the field,
  // silently ignored everywhere else rather than stored and never acted on.
  const continuationFrame =
    supportsFirstFrameContinuation(model) && typeof body.continuationFrame === "string"
      ? body.continuationFrame
      : undefined;

  if (!prompt) {
    return NextResponse.json({ error: "Prompt is required." }, { status: 400 });
  }
  const maxPromptLength = await readEffectiveLimit("maxPromptLength", user?.id);
  if (prompt.length > maxPromptLength) {
    return NextResponse.json(
      {
        error: `Prompt is too long (max ${maxPromptLength} characters, this one is ${prompt.length}). An admin can raise this limit from the dashboard.`,
      },
      { status: 400 }
    );
  }
  // Reject loudly rather than silently dropping the extras — the user chose
  // those clips and would otherwise get a result that ignored some of them.
  if (
    Array.isArray(body.referenceVideos) &&
    body.referenceVideos.length > MAX_REFERENCE_VIDEOS &&
    supportsVideoReference(model)
  ) {
    return NextResponse.json(
      {
        error: `${model} accepts at most ${MAX_REFERENCE_VIDEOS} reference clips (got ${body.referenceVideos.length}).`,
      },
      { status: 400 }
    );
  }
  // Seedance 2.0 Mini has no 1080p/4k SKU (per its MCP schema) — reject
  // loudly rather than letting the provider silently downgrade.
  if (/seedance.*mini/i.test(model) && !["480p", "720p"].includes(resolution || "")) {
    return NextResponse.json(
      { error: `Seedance 2.0 Mini supports 480p/720p only (got ${resolution}).` },
      { status: 400 }
    );
  }
  // Seedance 2.0/2.5 take any integer duration within BytePlus's documented
  // bounds rather than a fixed enum (see durationRangeForModel) — reject
  // outside that range up front instead of letting BytePlus 400 it async on
  // the poll. Edit forces duration to -1 (match source) at the provider
  // layer regardless of what's sent, so it's exempt; Extend passes through
  // a real duration when given, so it stays covered.
  if (videoTaskMode !== "edit") {
    const durationRange = durationRangeForModel(model);
    if (
      durationRange &&
      duration != null &&
      (!Number.isInteger(duration) || duration < durationRange.min || duration > durationRange.max)
    ) {
      return NextResponse.json(
        {
          error: `${model} supports ${durationRange.min}-${durationRange.max}s durations (got ${duration}).`,
        },
        { status: 400 }
      );
    }
  }
  // Edit/Extend need a source clip to act on and only exist on Seedance 2.5 —
  // reject loudly rather than letting the request reach BytePlus and fail
  // async on the poll with an opaque TaskTypeConstraint error.
  if (videoTaskMode !== "generate") {
    if (!supportsVideoEditExtend(model)) {
      return NextResponse.json(
        { error: `${model} does not support ${videoTaskMode === "edit" ? "Edit" : "Extend"}.` },
        { status: 400 }
      );
    }
    if (!referenceVideos.length) {
      return NextResponse.json(
        {
          error: `Attach a reference clip to ${videoTaskMode === "edit" ? "edit" : "extend"} a video.`,
        },
        { status: 400 }
      );
    }
  }
  // Omni's request contract is probe-measured (see providers/omni.ts header):
  // 16:9/9:16 only, no controllable resolution, and duration IS a real
  // enforced request field (response_format.duration) — reject anything
  // outside the offered set up front instead of letting the provider layer
  // silently reinterpret it.
  if (isOmniModel(model)) {
    if (!aspectRatiosForModel(model, "video").includes(aspectRatio)) {
      return NextResponse.json(
        { error: `Gemini Omni Flash supports 16:9/9:16 aspect ratios only (got ${aspectRatio}).` },
        { status: 400 }
      );
    }
    if (!durationsForModel(model).includes(duration || 0)) {
      return NextResponse.json(
        {
          error: `Gemini Omni Flash supports ${durationsForModel(model).join("/")}s durations (got ${duration}).`,
        },
        { status: 400 }
      );
    }
    if (!resolutionsForModel(model, "video").includes(resolution || "")) {
      return NextResponse.json(
        { error: `Gemini Omni Flash supports ${resolutionsForModel(model, "video").join("/")} only (got ${resolution}).` },
        { status: 400 }
      );
    }
  }

  const id = crypto.randomUUID();
  const now = Date.now();

  // Wrapped: several of these are DB/storage calls (readPricing, saveRef-
  // erenceImages, upsertItem, logActivity) — an unhandled throw here would
  // otherwise crash the route with no JSON body at all, and the client's
  // `res.json()` fails with a raw "Unexpected end of JSON input" instead of
  // a readable error.
  let costCents;
  let savedRefs;
  let continuationFrameUrl;
  try {
    costCents = computeCostCents(
      { kind: "video", model, resolution, duration, generateAudio },
      await readPricing()
    );
    savedRefs = referenceImages?.length
      ? await saveReferenceImages(referenceImages, id)
      : undefined;
    // Suffixed id, not the bare generation id: saveReferenceImages numbers
    // its own outputs from 0 per call, so reusing the same id here would
    // collide with referenceImages' own references/${id}-0.ext when both are
    // present on the same request.
    continuationFrameUrl = continuationFrame
      ? (await saveReferenceImages([continuationFrame], `${id}-continuation`))[0]
      : undefined;
  } catch (e) {
    return NextResponse.json(
      { error: e?.message || "Failed to prepare the generation request." },
      { status: 500 }
    );
  }
  const base = {
    id,
    kind: "video",
    status: "queued",
    prompt,
    model,
    aspectRatio,
    resolution,
    duration,
    referenceImages: savedRefs,
    referenceVideos: referenceVideos.length ? referenceVideos : undefined,
    continuationFrameUrl,
    generateAudio,
    videoTaskMode: videoTaskMode !== "generate" ? videoTaskMode : undefined,
    projectId,
    folderId,
    userId: user?.id,
    costCents,
    seed,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await upsertItem(base);
    await logActivity(user?.id ?? null, "generate", {
      id,
      kind: "video",
      model,
      costCents,
    });
    return NextResponse.json(base);
  } catch (e) {
    return NextResponse.json(
      { error: e?.message || "Failed to save the generation request." },
      { status: 500 }
    );
  }
}
