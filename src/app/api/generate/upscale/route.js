import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { upsertItem } from "@/lib/store-db";
import { logActivity } from "@/lib/activity";
import { readImageAsBase64, saveReferenceImages } from "@/lib/save-media";
import { submitMagnificUpscale } from "@/lib/providers/magnific";
import { readPricing } from "@/lib/pricing-db";
import { InvalidUpscaleRequest, inspectUpscaleImage, validateUpscaleRequest, validateUpscaleSourceReference } from "@/lib/magnific-validation";

export const runtime = "nodejs";
export const maxDuration = 60;

function computeAspectRatioString(width, height) {
  if (!width || !height) return "1:1";
  const ratio = width / height;
  const standardRatios = [
    { label: "1:1", val: 1 },
    { label: "16:9", val: 16 / 9 },
    { label: "9:16", val: 9 / 16 },
    { label: "4:3", val: 4 / 3 },
    { label: "3:4", val: 3 / 4 },
    { label: "3:2", val: 3 / 2 },
    { label: "2:3", val: 2 / 3 },
    { label: "21:9", val: 21 / 9 },
  ];
  let closest = standardRatios[0];
  let minDiff = Math.abs(ratio - closest.val);
  for (const r of standardRatios) {
    const diff = Math.abs(ratio - r.val);
    if (diff < minDiff) {
      minDiff = diff;
      closest = r;
    }
  }
  return minDiff < 0.08 ? closest.label : `${width}:${height}`;
}

export async function POST(req) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  let validated;
  try {
    validated = validateUpscaleRequest(body);
    validateUpscaleSourceReference(body.image, req.nextUrl.origin);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  const rawImage = validated.image;
  const model = validated.model;
  const params = validated.params;
  const projectId = body.projectId || undefined;
  const folderId = body.folderId || undefined;
  const prompt = (params.prompt || body.prompt || "").trim();
  const scaleFactor = params.scaleFactor || "2x";

  const id = crypto.randomUUID();
  const now = Date.now();

  try {
    // Read the source image into base64 data URI
    const { data, mimeType } = await readImageAsBase64(rawImage, AbortSignal.timeout(15_000));
    const { meta } = await inspectUpscaleImage(data, mimeType);
    const dataUri = `data:${mimeType.toLowerCase()};base64,${data}`;
    const aspectRatio = computeAspectRatioString(meta.width, meta.height);

    // Persist source reference image so card shows original reference
    // Do not fall back to storing a potentially 27 MB data URI in PostgreSQL.
    // If durable reference storage is unavailable, fail before submitting a
    // billable provider job so the user can retry safely.
    const savedRefs = await saveReferenceImages([rawImage.startsWith("data:") ? dataUri : rawImage], id);

    // Submit to Magnific API
    const result = await submitMagnificUpscale({
      model,
      image: dataUri,
      params,
    });

    const prices = await readPricing();
    const costCents = prices.find((price) => price.model === model)?.unitCostCents;
    if (!Number.isInteger(costCents)) throw new Error(`Pricing is not configured for ${model}.`);

    const base = {
      id,
      kind: "image",
      status: "running",
      prompt: prompt || `${model} (${scaleFactor})`,
      model,
      aspectRatio,
      resolution: scaleFactor,
      taskId: result.taskId,
      referenceImages: savedRefs,
      projectId,
      folderId,
      userId: user.id,
      costCents,
      costBasis: "estimated",
      createdAt: now,
      updatedAt: now,
      submittedAt: now,
      nextPollAt: now + 5_000,
    };

    await upsertItem(base);
    await logActivity(user.id, "generate", { id, kind: "image", model, costCents });

    return NextResponse.json(base);
  } catch (e) {
    console.error("[generate/upscale] Error:", e);
    return NextResponse.json(
      { error: e?.message || "Failed to start upscale generation." },
      { status: e instanceof InvalidUpscaleRequest ? 400 : 500 }
    );
  }
}
