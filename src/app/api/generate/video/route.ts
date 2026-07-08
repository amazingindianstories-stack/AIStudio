import { NextRequest, NextResponse } from "next/server";
import { createVideoTask } from "@/lib/providers/seedance";
import {
  isHiggsfieldModel,
  mcpGenerateVideo,
  mcpUploadImage,
} from "@/lib/providers/higgsfield-mcp";
import { readImageAsBase64, saveReferenceImages } from "@/lib/save-media";
import { prepReference } from "@/lib/middleware/image-prep";
import { upsertItem } from "@/lib/store-db";
import { isMock, mockPlaceholder } from "@/lib/mock";
import { resolveReferences } from "@/lib/mentions";
import { getSession } from "@/lib/auth";
import { readPricing } from "@/lib/pricing-db";
import { computeCostCents } from "@/lib/pricing";
import { logActivity } from "@/lib/activity";
import type { GenerationItem } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

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

  try {
    if (isMock()) {
      base.taskId = `mock-${id}`;
      base.poster = await mockPlaceholder(id, prompt, aspectRatio, model);
      base.status = "running";
      await upsertItem(base);
      return NextResponse.json(base);
    }

    let taskId: string;
    if (isHiggsfieldModel(model)) {
      // Higgsfield (Seedance 2.0) via the official MCP — supports MULTIPLE
      // reference images natively (image_references), no collage workaround.
      const refs = referenceImages ?? [];
      const mediaIds: string[] = [];

      if (!refs.length) {
        console.log("[video] No reference image provided for Seedance. Auto-generating base frame via Gemini (T2V fallback)...");
        const { generateImageGemini } = await import("@/lib/providers/gemini");
        const { uploadBase64 } = await import("@/lib/storage");
        
        // Generate the base frame using Nano Banana Pro
        const genRes = await generateImageGemini({
          assembled: { instruction: prompt, groups: [] },
          aspectRatio,
        });

        // Save the generated image so the user can see it in their timeline/history
        const ext = genRes.mimeType.split("/")[1] || "png";
        const autoRefUrl = await uploadBase64(genRes.base64, `references/${id}-auto.${ext}`, ext);
        
        // Attach it to the DB record
        base.referenceImages = [autoRefUrl];

        // Upload to MCP
        const mediaId = await mcpUploadImage(genRes.base64, genRes.mimeType);
        mediaIds.push(mediaId);
      } else {
        for (const ref of refs) {
          const raw = await readImageAsBase64(ref);
          const { mimeType, data } = await prepReference(raw.mimeType, raw.data);
          mediaIds.push(await mcpUploadImage(data, mimeType));
        }
      }
      console.log(`[video] MCP seedance with ${mediaIds.length} reference image(s)`);
      taskId = await mcpGenerateVideo({
        model,
        prompt,
        aspectRatio,
        duration,
        resolution,
        mediaIds,
      });
    } else {
      taskId = await createVideoTask({
        prompt,
        modelDisplay: model,
        ratio: aspectRatio,
        resolution,
        duration,
        references: resolveReferences(prompt, referenceImages ?? []),
      });
    }
    base.taskId = taskId;
    base.status = "running";
    await upsertItem(base);
    await logActivity(user?.id ?? null, "generate", {
      id,
      kind: "video",
      model,
      costCents,
    });
    return NextResponse.json(base);
  } catch (e: any) {
    const failed: GenerationItem = {
      ...base,
      status: "failed",
      error: e?.message || "Video task creation failed.",
      moderationBlocked: e?.code === "moderation",
      updatedAt: Date.now(),
    };
    await upsertItem(failed);
    return NextResponse.json(failed);
  }
}
