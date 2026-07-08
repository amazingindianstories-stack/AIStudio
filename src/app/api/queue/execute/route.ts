import { NextRequest, NextResponse } from "next/server";
import { generateImageGemini } from "@/lib/providers/gemini";
import {
  isHiggsfieldModel,
  mcpAwaitJob,
  mcpGenerateImage,
  mcpUploadImage,
} from "@/lib/providers/higgsfield-mcp";
import {
  readImageAsBase64,
  saveBase64,
  saveFromUrl,
  saveReferenceImages,
} from "@/lib/save-media";
import { upsertItem, lockJob, getItem } from "@/lib/store-db";
import { isMock, mockPlaceholder } from "@/lib/mock";
import { prepReference } from "@/lib/middleware/image-prep";
import { judgeIdentity } from "@/lib/middleware/face-judge";
import { assemblePrompt } from "@/lib/prompt-assembler";
import { readAssets } from "@/lib/assets-db";
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
      const assembled = await assemblePrompt(prompt, assets, referenceImages ?? []);
      const refImageCount = assembled.groups.reduce(
        (n, g) => n + g.images.length,
        0
      );
      const input = {
        assembled,
        aspectRatio,
        imageSize: resolutionToImageSize(resolution),
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
          `groups=${assembled.groups.length} refImages=${refImageCount} bestOf=${bestOf}`
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
      } else {
        ({ base64, mimeType } = await generateImageGemini(input));
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
