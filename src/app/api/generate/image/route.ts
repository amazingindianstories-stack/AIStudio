import { NextRequest, NextResponse } from "next/server";
import { saveReferenceImages } from "@/lib/save-media";
import { upsertItem } from "@/lib/store-db";
import { getSession } from "@/lib/auth";
import { readPricing } from "@/lib/pricing-db";
import { computeCostCents } from "@/lib/pricing";
import { logActivity } from "@/lib/activity";
import type { GenerationItem } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60; // Nano Banana Pro high-res can take ~30–60s

function resolutionToImageSize(res?: string): "1K" | "2K" | "4K" {
  if (res === "4K") return "4K";
  if (res === "2K" || res === "1080p") return "2K";
  return "1K";
}

export async function POST(req: NextRequest) {
  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const prompt: string = (body.prompt || "").trim();
  const aspectRatio: string = body.aspectRatio || "1:1";
  const resolution: string | undefined = body.resolution;
  const model: string = body.model || "Nano Banana Pro";
  const referenceImages: string[] | undefined = body.referenceImages;
  const projectId: string | undefined = body.projectId || undefined;
  const folderId: string | undefined = body.folderId || undefined;

  if (!prompt) {
    return NextResponse.json({ error: "Prompt is required." }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const now = Date.now();

  // Wrapped: readPricing/saveReferenceImages/upsertItem/logActivity all hit
  // the DB or storage — an unhandled throw here would otherwise crash the
  // route with no JSON body at all, and the client's `res.json()` fails with
  // a raw "Unexpected end of JSON input" instead of a readable error.
  let costCents: number;
  let savedRefs: string[] | undefined;
  try {
    const pricingRows = await readPricing();
    costCents = computeCostCents({ kind: "image", model, resolution }, pricingRows);
    // Persist the uploaded references with the item so they can be shown
    // later and reused via "Clone & try" (the provider still gets the raw
    // data URLs).
    savedRefs = referenceImages?.length
      ? await saveReferenceImages(referenceImages, id)
      : undefined;
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Failed to prepare the generation request." },
      { status: 500 }
    );
  }
  const base: GenerationItem = {
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
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Failed to save the generation request." },
      { status: 500 }
    );
  }
}
