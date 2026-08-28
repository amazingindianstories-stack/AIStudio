import { NextResponse } from "next/server";
import { saveReferenceImages } from "@/lib/save-media";
import { upsertItem } from "@/lib/store-db";
import { getSession } from "@/lib/auth";
import { readPricing } from "@/lib/pricing-db";
import { computeCostCents } from "@/lib/pricing";
import { readEffectiveLimit } from "@/lib/limits-db";
import { logActivity } from "@/lib/activity";
import { supportsSeed } from "@/lib/config";

export const runtime = "nodejs";
export const maxDuration = 60; // Nano Banana Pro high-res can take ~30–60s

export async function POST(req) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const prompt = (body.prompt || "").trim();
  const aspectRatio = body.aspectRatio || "1:1";
  const resolution = body.resolution;
  const model = body.model || "Nano Banana Pro";
  const referenceImages = body.referenceImages;
  const projectId = body.projectId || undefined;
  const folderId = body.folderId || undefined;
  // "Regenerate with same seed" (Phase 3.1): only honoured for models
  // supportsSeed actually confirms support for — silently dropped elsewhere
  // rather than stored and never acted on, same convention generateAudio uses
  // on the video route. queue/execute still backfills a fresh seed when this
  // is undefined and the model supports it, so leaving it off here (the
  // ordinary "new generation" case) is not a regression.
  const seed = supportsSeed(model) && Number.isInteger(body.seed) ? body.seed : undefined;

  if (!prompt) {
    return NextResponse.json({ error: "Prompt is required." }, { status: 400 });
  }

  const maxPromptLength = await readEffectiveLimit("maxPromptLength", user.id);
  if (prompt.length > maxPromptLength) {
    return NextResponse.json(
      {
        error: `Prompt is too long (max ${maxPromptLength} characters, this one is ${prompt.length}). An admin can raise this limit from the dashboard.`,
      },
      { status: 400 }
    );
  }

  const id = crypto.randomUUID();
  const now = Date.now();

  // Wrapped: readPricing/saveReferenceImages/upsertItem/logActivity all hit
  // the DB or storage — an unhandled throw here would otherwise crash the
  // route with no JSON body at all, and the client's `res.json()` fails with
  // a raw "Unexpected end of JSON input" instead of a readable error.
  let costCents;
  let savedRefs;
  try {
    const pricingRows = await readPricing();
    costCents = computeCostCents(
      {
        kind: "image",
        model,
        resolution,
        // Kling Image 2.1 bills image-to-image at double its text-to-image rate,
        // so the presence of a reference changes the price, not just the payload.
        hasReferenceImage: !!referenceImages?.length,
      },
      pricingRows
    );
    // Persist the uploaded references with the item so they can be shown
    // later and reused via "Clone & try" (the provider still gets the raw
    // data URLs).
    savedRefs = referenceImages?.length
      ? await saveReferenceImages(referenceImages, id)
      : undefined;
  } catch (e) {
    return NextResponse.json(
      { error: e?.message || "Failed to prepare the generation request." },
      { status: 500 }
    );
  }
  const base = {
    id,
    kind: "image",
    status: "queued",
    prompt,
    model,
    aspectRatio,
    resolution,
    referenceImages: savedRefs,
    projectId,
    folderId,
    userId: user.id,
    costCents,
    seed,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await upsertItem(base);
    await logActivity(user.id, "generate", {
      id,
      kind: "image",
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
