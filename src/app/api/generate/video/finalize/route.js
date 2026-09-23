import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getItem, upsertItem } from "@/lib/store-db";
import { readPricing } from "@/lib/pricing-db";
import { computeCostCents } from "@/lib/pricing";
import { logActivity } from "@/lib/activity";
import { buildFinalGeneration, validateDraftForFinalization } from "@/lib/seedance-finalization";

export const runtime = "nodejs";

export async function POST(req) {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  if (typeof body.sourceGenerationId !== "string" || !body.sourceGenerationId) {
    return NextResponse.json({ error: "sourceGenerationId is required." }, { status: 400 });
  }
  const source = await getItem(body.sourceGenerationId);
  const validationError = validateDraftForFinalization(source);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: source ? 400 : 404 });
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  try {
    const costCents = computeCostCents(
      { kind: "video", model: source.model, resolution: "1080p", duration: source.duration, generateAudio: source.generateAudio },
      await readPricing()
    );
    const item = buildFinalGeneration(source, { id, userId: user.id, costCents, now });
    await upsertItem(item);
    await logActivity(user.id, "generate", { id, kind: "video", model: source.model, costCents, sourceGenerationId: source.id });
    return NextResponse.json({ ...item, sourceGenerationId: item.sourceGenerationId ?? null, draftTaskId: item.draftTaskId ?? null });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Failed to queue the final render." }, { status: 500 });
  }
}
