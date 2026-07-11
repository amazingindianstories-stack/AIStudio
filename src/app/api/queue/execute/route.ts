import { NextRequest, NextResponse } from "next/server";
import { generateImageGemini } from "@/lib/providers/gemini";
import {
  isHiggsfieldModel,
  mcpAwaitJob,
  mcpGenerateImage,
  mcpGenerateVideo,
  mcpUploadImage,
} from "@/lib/providers/higgsfield-mcp";
import { createVideoTask } from "@/lib/providers/seedance";
import { isOmniModel, createOmniVideoTask } from "@/lib/providers/omni";
import { resolveReferences } from "@/lib/mentions";
import {
  readImageAsBase64,
  saveBase64,
  saveFromUrl,
  saveReferenceImages,
} from "@/lib/save-media";
import { upsertItem, lockJob, getItem } from "@/lib/store-db";
import { isMock, mockPlaceholder } from "@/lib/mock";
import { crispen, prepReference } from "@/lib/middleware/image-prep";
import { judgeCandidate, judgeIdentity, selectBestCandidate } from "@/lib/middleware/face-judge";
import { assemblePrompt } from "@/lib/prompt-assembler";
import { readAssets } from "@/lib/assets-db";
import { getSession } from "@/lib/auth";
import { readPricing } from "@/lib/pricing-db";
import { computeCostCents } from "@/lib/pricing";
import { logActivity } from "@/lib/activity";
import type { GenerationItem } from "@/lib/types";
import sharp from "sharp";

export const runtime = "nodejs";
export const maxDuration = 60; // Nano Banana Pro high-res can take ~30–60s

function resolutionToImageSize(res?: string): "1K" | "2K" | "4K" {
  if (res === "4K") return "4K";
  if (res === "2K" || res === "1080p") return "2K";
  return "1K";
}

// SUPERSAMPLE=1: render one step up (1K→2K, 2K→4K; 4K has no step up). Each
// NBP size step measured as an exact 2× linear scale at a fixed aspect ratio
// (21:9/2K = 3168×1344, 21:9/4K = 6336×2688 — see gemini.ts header), so the
// delivered image is downsampled to exactly half the rendered pixel
// dimensions to land back on the originally requested size.
const NEXT_IMAGE_SIZE: Record<"1K" | "2K" | "4K", "1K" | "2K" | "4K"> = {
  "1K": "2K",
  "2K": "4K",
  "4K": "4K",
};

/** SUPERSAMPLE delivery step: NEXT_IMAGE_SIZE is always exactly one step up,
 *  so halving the rendered image's actual pixel dimensions lands back on the
 *  originally requested size, without a hardcoded per-aspect-ratio pixel
 *  table. Only called when a step-up actually happened. Fail-open: returns
 *  the rendered bytes unchanged on any error. */
async function halveForDelivery(base64: string): Promise<string> {
  try {
    const buf = Buffer.from(base64, "base64");
    const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.height) return base64;
    const out = await sharp(buf)
      .resize({
        width: Math.round(meta.width / 2),
        height: Math.round(meta.height / 2),
        fit: "inside",
        kernel: "lanczos3",
      })
      .toBuffer();
    return out.toString("base64");
  } catch {
    return base64;
  }
}

/** Create the provider task for a locked video job. Returns the item with
 *  taskId + status "running" (does not persist). */
async function submitVideo(base: GenerationItem): Promise<GenerationItem> {
  const { id, prompt, aspectRatio, resolution, duration, model } = base;

  if (isMock()) {
    return {
      ...base,
      taskId: `mock-${id}`,
      poster: await mockPlaceholder(id, prompt, aspectRatio, model),
      status: "running",
      updatedAt: Date.now(),
    };
  }

  let taskId: string;
  const refUpdates: Partial<GenerationItem> = {};
  if (isOmniModel(model)) {
    // Same context-engineering path Nano Banana Pro uses for images — role-
    // labeled reference groups + identity tiles + shot-spec framing/negative
    // codas — instead of a flat hand-rolled prompt (see omni-input.ts).
    const assembled = await assemblePrompt(prompt, await readAssets(), base.referenceImages ?? [], {
      aspectRatio,
      medium: "video",
    });
    const refImageCount = assembled.groups.reduce((n, g) => n + g.images.length, 0);
    console.log(
      `[video] model=${model} uploads=${base.referenceImages?.length ?? 0} ` +
        `groups=${assembled.groups.length} refImages=${refImageCount} duration=${duration}s`
    );
    taskId = await createOmniVideoTask({
      assembled,
      aspectRatio,
      duration: duration || 4,
    });
  } else if (isHiggsfieldModel(model)) {
    // Higgsfield (Seedance 2.0/Mini) via the official MCP — supports MULTIPLE
    // reference images natively (image_references), no collage workaround.
    const refs = base.referenceImages ?? [];
    const mediaIds: string[] = [];

    if (!refs.length) {
      console.log(
        "[video] No reference image provided for Seedance. Auto-generating base frame via Gemini (T2V fallback)..."
      );
      const { uploadBase64 } = await import("@/lib/storage");
      const genRes = await generateImageGemini({
        assembled: { instruction: prompt, groups: [] },
        aspectRatio,
      });
      // Save the generated frame so the user can see it in their history.
      const ext = genRes.mimeType.split("/")[1] || "png";
      const autoRefUrl = await uploadBase64(genRes.base64, `references/${id}-auto.${ext}`, ext);
      refUpdates.referenceImages = [autoRefUrl];
      mediaIds.push(await mcpUploadImage(genRes.base64, genRes.mimeType));
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
      references: resolveReferences(prompt, base.referenceImages ?? []),
    });
  }
  return { ...base, ...refUpdates, taskId, status: "running", updatedAt: Date.now() };
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const id: string = body.id;

  if (!id) {
    return NextResponse.json({ error: "Job ID is required." }, { status: 400 });
  }

  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  // Attempt to acquire the queue lock for this job
  const locked = await lockJob(id);
  if (!locked) {
    return NextResponse.json({ error: "Job is already running or invalid." }, { status: 400 });
  }

  // Fetch the full job state
  const base = await getItem(id);
  if (!base) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }

  const { prompt, aspectRatio, resolution, model, referenceImages } = base;
  let costCents = base.costCents || 0;

  // Video: submit the provider task (remote render) and return the running
  // item — the client's pollVideo then drives /api/generate/video/status.
  // Living here (not in the enqueue route) keeps concurrent renders inside
  // the queue's per-kind cap.
  if (base.kind === "video") {
    try {
      const running = await submitVideo(base);
      await upsertItem(running);
      return NextResponse.json(running);
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

  try {
    let url: string;
    if (isMock()) {
      await new Promise((r) => setTimeout(r, 700));
      url = await mockPlaceholder(id, prompt, aspectRatio, model);
    } else if (isHiggsfieldModel(model)) {
      // Higgsfield image via the MCP — Soul (photoreal, one ref, `quality`)
      // or Nano Banana Pro (all refs, `resolution` 1k/2k/4k). Upload refs,
      // submit, then poll the job to completion.
      const assembled = await assemblePrompt(prompt, await readAssets(), referenceImages ?? []);
      const isNanoBanana = /nano banana/i.test(model);
      const refs = isNanoBanana
        ? referenceImages ?? []
        : (referenceImages ?? []).slice(0, 1);
      let mediaIds: string[] | undefined;
      if (refs.length) {
        mediaIds = [];
        for (const ref of refs) {
          const raw = await readImageAsBase64(ref);
          const { mimeType, data } = await prepReference(raw.mimeType, raw.data);
          mediaIds.push(await mcpUploadImage(data, mimeType));
        }
      }
      const quality = resolution === "1K" ? "1.5k" : "2k";
      const nbResolution = (resolution || "2K").toLowerCase(); // "1k" | "2k" | "4k"
      console.log(
        `[image] MCP ${isNanoBanana ? `nano-banana res=${nbResolution}` : `soul quality=${quality}`}, refs=${mediaIds?.length ?? 0}`
      );
      const jobId = await mcpGenerateImage({
        model,
        prompt: assembled.instruction,
        aspectRatio,
        ...(isNanoBanana ? { resolution: nbResolution } : { quality }),
        mediaIds,
      });
      const done = await mcpAwaitJob(jobId);
      if (done.status !== "succeeded" || !done.url) {
        throw new Error(done.error || "Higgsfield image generation failed.");
      }
      // Persist Higgsfield's hosted result locally so it survives URL expiry.
      url = await saveFromUrl(done.url, "png", id);
    } else {
      // Context engineering: resolve @slug assets + @imgN uploads into a
      // structured, role-labeled payload (literal SCENE + grouped references).
      const assets = await readAssets();
      const assembled = await assemblePrompt(prompt, assets, referenceImages ?? [], {
        aspectRatio,
      });
      const refImageCount = assembled.groups.reduce(
        (n, g) => n + g.images.length,
        0
      );
      const requestedSize = resolutionToImageSize(resolution);
      const supersampleOn = process.env.SUPERSAMPLE === "1";
      const renderSize = supersampleOn ? NEXT_IMAGE_SIZE[requestedSize] : requestedSize;
      if (supersampleOn && renderSize !== requestedSize) {
        // Bill what actually ran: the rendered (higher) size, not the
        // originally requested one.
        const pricingRows = await readPricing();
        costCents = computeCostCents({ kind: "image", model, resolution: renderSize }, pricingRows);
      }
      const input = {
        assembled,
        aspectRatio,
        imageSize: renderSize,
        modelDisplay: model,
      };
      // Best-of-N: generation is stochastic (identity swings 5–65 on the same
      // config), so when a face is locked we generate N candidates in parallel,
      // auto-judge each against the reference face and keep the best. This is
      // the measured lever — single-pass tricks and face-fix second passes
      // both failed the bake-off.
      const bestOf = assembled.judgeFace
        ? Math.min(4, Math.max(1, Number(process.env.FACE_BEST_OF) || 2))
        : 1;
      console.log(
        `[image] model=${model} uploads=${referenceImages?.length ?? 0} ` +
          `groups=${assembled.groups.length} refImages=${refImageCount} bestOf=${bestOf} ` +
          `imageSize=${renderSize}`
      );
      let base64: string;
      let mimeType: string;
      if (bestOf > 1) {
        const settled = await Promise.allSettled(
          Array.from({ length: bestOf }, () => generateImageGemini(input))
        );
        const candidates = settled.filter(
          (s): s is PromiseFulfilledResult<{ base64: string; mimeType: string }> =>
            s.status === "fulfilled"
        );
        if (!candidates.length) {
          throw settled[0].status === "rejected"
            ? settled[0].reason
            : new Error("Image generation failed.");
        }
        // Bill what actually ran.
        costCents = costCents * candidates.length;
        if (process.env.JUDGE_COMPOSITE === "1") {
          // Widened judge: identity + subject prominence + face sharpness in
          // one call each, picked subject to an identity floor so identity
          // never regresses vs the identity-only picker below.
          const scores = await Promise.all(
            candidates.map((c) =>
              judgeCandidate(assembled.judgeFace!, {
                mimeType: c.value.mimeType,
                data: c.value.base64,
              })
            )
          );
          const best = selectBestCandidate(scores, 8);
          console.log(
            `[image] best-of-${candidates.length} composite scores: ` +
              `${scores
                .map((s) => (s ? `id${s.identity}/pr${s.prominence}/sh${s.sharpness}` : "n/a"))
                .join(", ")} → picked #${best + 1}`
          );
          ({ base64, mimeType } = candidates[best].value);
        } else {
          const scores = await Promise.all(
            candidates.map((c) =>
              judgeIdentity(assembled.judgeFace!, {
                mimeType: c.value.mimeType,
                data: c.value.base64,
              })
            )
          );
          let best = 0;
          for (let i = 1; i < scores.length; i++) {
            if ((scores[i] ?? -1) > (scores[best] ?? -1)) best = i;
          }
          console.log(
            `[image] best-of-${candidates.length} identity scores: ` +
              `${scores.map((s) => s ?? "n/a").join(", ")} → picked #${best + 1}`
          );
          ({ base64, mimeType } = candidates[best].value);
        }
      } else {
        ({ base64, mimeType } = await generateImageGemini(input));
      }

      if (process.env.POST_CRISPEN === "1") {
        ({ data: base64, mimeType } = await crispen(mimeType, base64));
      }
      if (supersampleOn && renderSize !== requestedSize) {
        base64 = await halveForDelivery(base64);
      }

      const ext = mimeType.includes("jpeg") ? "jpg" : "png";
      url = await saveBase64(base64, ext, id);
    }
    const done: GenerationItem = {
      ...base,
      status: "succeeded",
      url,
      costCents, // includes the NB2 face-refine pass when it ran
      updatedAt: Date.now(),
    };
    await upsertItem(done);
    return NextResponse.json(done);
  } catch (e: any) {
    const failed: GenerationItem = {
      ...base,
      status: "failed",
      error: e?.message || "Image generation failed.",
      updatedAt: Date.now(),
    };
    await upsertItem(failed);
    return NextResponse.json(failed);
  }
}
