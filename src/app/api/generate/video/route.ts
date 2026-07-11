import { NextRequest, NextResponse } from "next/server";
import { saveReferenceImages } from "@/lib/save-media";
import { upsertItem } from "@/lib/store-db";
import { getSession } from "@/lib/auth";
import { readPricing } from "@/lib/pricing-db";
import { computeCostCents } from "@/lib/pricing";
import { logActivity } from "@/lib/activity";
import { aspectRatiosForModel, durationsForModel, resolutionsForModel } from "@/lib/config";
import { isOmniModel } from "@/lib/providers/omni";
import type { GenerationItem } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Enqueue-only (mirrors the image route): creates the `queued` row and
 * returns it. The client polls /api/queue/status and calls
 * /api/queue/execute when it reaches the front — that route owns provider
 * submission, so concurrent load stays inside the per-kind caps.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const prompt: string = (body.prompt || "").trim();
  const aspectRatio: string = body.aspectRatio || "16:9";
  const resolution: string | undefined = body.resolution || "1080p";
  const duration: number | undefined = body.duration || 5;
  const model: string = body.model || "Higgsfield Seedance 2.0";
  const referenceImages: string[] | undefined = body.referenceImages;
  const projectId: string | undefined = body.projectId || undefined;
  const folderId: string | undefined = body.folderId || undefined;

  if (!prompt) {
    return NextResponse.json({ error: "Prompt is required." }, { status: 400 });
  }
  // Seedance 2.0 Mini has no 1080p/4k SKU (per its MCP schema) — reject
  // loudly rather than letting the provider silently downgrade.
  if (/seedance.*mini/i.test(model) && !["480p", "720p"].includes(resolution || "")) {
    return NextResponse.json(
      { error: `Seedance 2.0 Mini supports 480p/720p only (got ${resolution}).` },
      { status: 400 }
    );
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
  const user = await getSession();
  const costCents = computeCostCents(
    { kind: "video", model, resolution, duration },
    await readPricing()
  );
  const savedRefs = referenceImages?.length
    ? await saveReferenceImages(referenceImages, id)
    : undefined;
  const base: GenerationItem = {
    id,
    kind: "video",
    status: "queued",
    prompt,
    model,
    aspectRatio,
    resolution,
    duration,
    referenceImages: savedRefs,
    projectId,
    folderId,
    userId: user?.id,
    costCents,
    createdAt: now,
    updatedAt: now,
  };
  await upsertItem(base);
  await logActivity(user?.id ?? null, "generate", {
    id,
    kind: "video",
    model,
    costCents,
  });
  return NextResponse.json(base);
}
