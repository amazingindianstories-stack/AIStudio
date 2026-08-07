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
import {
  generateImageKling,
  isKlingModel,
  nearestKlingAspectRatio,
  prepKlingReference,
} from "@/lib/providers/kling";
import { isOmniModel, createOmniVideoTask } from "@/lib/providers/omni";
import { buildKlingInput } from "@/lib/kling-input";
import { resolveReferences, resolveVideoReferences } from "@/lib/mentions";
import {
  readImageAsBase64,
  saveBase64,
  saveFromUrl,
  saveReferenceImages,
} from "@/lib/save-media";
import { signStoredRef } from "@/lib/storage";
import { upsertItem, lockJob, getItem } from "@/lib/store-db";
import { isMock, mockPlaceholder } from "@/lib/mock";
import { crispen, prepReference } from "@/lib/middleware/image-prep";
import { judgeCandidate, judgeIdentity, selectBestCandidate } from "@/lib/middleware/face-judge";
import { assemblePrompt } from "@/lib/prompt-assembler";
import { readAssets } from "@/lib/assets-db";
import { getSession } from "@/lib/auth";
import { readPricing } from "@/lib/pricing-db";
import { computeCostCents, klingUnitsToCents } from "@/lib/pricing";
import { logActivity } from "@/lib/activity";
import type { GenerationItem } from "@/lib/types";
import sharp from "sharp";

export const runtime = "nodejs";
// A single NBP high-res render is ~30–60s, but this route can run several of
// them back to back: best-of-N (FACE_BEST_OF) fans out N renders in parallel
// and then judges each one. Under Fluid compute concurrent invocations SHARE an
// instance, so two queued image jobs at bestOf=2 put four renders plus four
// judge calls on the same CPU and the wall clock crosses 60s — measured
// 2026-07-28, when a burst of 21:9/2K jobs produced 8 hard kills in 25 minutes
// (jobs that normally finish in 35–40s).
//
// 60s was never this project's platform ceiling — it was the old Hobby limit.
// This project is Pro with fluid compute and a 300s functionDefaultTimeout, so
// the cap below was self-imposed and simply throttled us under load. When Vercel
// kills the invocation at the cap, the catch block below never runs and the row
// is left stranded in "running" until reapStaleRunningImages picks it up.
//
// Keep in sync with STALE_RUNNING_MS in src/lib/store-db.ts, which MUST stay
// comfortably above this value or the reaper will fail jobs that are still
// legitimately running. (Next requires a statically analysable literal here, so
// the two constants can't share an import.)
export const maxDuration = 300;

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

/** Turn stored clip refs into short-lived URLs the provider can fetch.
 *  A ref that is already an absolute URL is passed through untouched. */
async function signVideoRefs(refs: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const ref of refs) {
    try {
      const signed = await signStoredRef(ref);
      out.push(signed ?? ref);
    } catch (e: any) {
      console.error("[video] could not sign reference clip", ref, e);
      // Carry the real reason through to the card. The first version of this
      // said only "could not be prepared", which told the user nothing they
      // could act on and told us nothing about which backend or credential
      // was at fault.
      throw new Error(
        `Reference clip could not be prepared for the provider. ${e?.message ?? e}`
      );
    }
  }
  return out;
}

/**
 * Materialise stored reference images as base64 data URIs for native BytePlus
 * Seedance.
 *
 * By the time a job executes, `referenceImages` are stored media URLs, not the
 * data URLs the client sent. BytePlus fetches a bare `image_url.url` from its
 * own servers, and our media proxy is auth-gated (and the path is relative
 * anyway), so a URL is unusable to it — the reference has to travel inline.
 *
 * ModelArk requires `data:image/<fmt>;base64,<data>` with a LOWERCASE format,
 * and accepts jpeg/png on this path, so anything else (WebP/GIF are both
 * allowed by `splitDataUrl` on upload) is re-encoded to JPEG rather than sent
 * as a format the provider will reject.
 */
async function toProviderDataUrls(refs: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const ref of refs) {
    const raw = await readImageAsBase64(ref);
    let { mimeType, data } = await prepReference(raw.mimeType, raw.data);
    if (!/^image\/(jpeg|png)$/i.test(mimeType)) {
      try {
        data = (await sharp(Buffer.from(data, "base64")).jpeg({ quality: 92 }).toBuffer())
          .toString("base64");
        mimeType = "image/jpeg";
      } catch {
        // Fail loudly here rather than posting a format BytePlus will reject
        // with an opaque error the user cannot act on.
        throw new Error(
          `Reference image could not be converted to JPEG for Seedance (was ${mimeType}).`
        );
      }
    }
    out.push(`data:${mimeType.toLowerCase()};base64,${data}`);
  }
  return out;
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
    // Native BytePlus ModelArk Seedance 2.0. resolveReferences maps @imgN to
    // uploads by position, so the inlined list must keep referenceImages' order.
    const inlined = await toProviderDataUrls(base.referenceImages ?? []);
    console.log(`[video] BytePlus seedance with ${inlined.length} reference image(s)`);
    taskId = await createVideoTask({
      prompt,
      modelDisplay: model,
      ratio: aspectRatio,
      resolution,
      duration,
      references: resolveReferences(prompt, inlined),
      // Signed here, at the last possible moment, and never persisted or sent
      // to the browser. BytePlus fetches the clip itself and /api/media/… is
      // session-gated, so a signed URL is the only thing it can actually read.
      referenceVideoUrls: await signVideoRefs(
        resolveVideoReferences(prompt, base.referenceVideos ?? [])
      ),
      // Read off the row, not off this request: /api/generate/video only
      // enqueues, so the user's choice reaches the provider through the
      // persisted column and nothing else.
      generateAudio: base.generateAudio === true,
      // Seedance 2.5 only — Edit/Extend an attached clip. Same "off the row,
      // not off this request" reasoning as generateAudio above.
      taskMode: base.videoTaskMode,
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
  // Normally the stored ratio is whatever was requested. Kling is the exception:
  // it ignores aspect_ratio in image-to-image, so the returned image is measured
  // and this is corrected to match (see the kling branch below).
  let aspectRatioOut = aspectRatio;

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
    } else if (isKlingModel(model)) {
      // Kling takes ONE reference image and ONE prompt string on this endpoint
      // (see providers/kling.ts). buildKlingInput adapts the assembled payload
      // to that shape: it counts references from the resolved GROUPS — so a
      // saved @slug asset actually reaches Kling instead of being dropped the
      // way iterating the raw uploads did — and rewrites the @tags that Kling
      // would otherwise receive as literal machine syntax.
      const assembled = await assemblePrompt(prompt, await readAssets(), referenceImages ?? [], {
        aspectRatio,
      });
      const klingInput = buildKlingInput(assembled, model);
      // Kling accepts jpg/png only; this app's uploads may be WebP.
      const refs = klingInput.reference
        ? [
            await prepKlingReference(
              klingInput.reference.mimeType,
              klingInput.reference.data
            ),
          ]
        : [];
      console.log(
        `[image] kling model=${model} refs=${refs.length} res=${resolution ?? "1K"} ` +
          `ar=${aspectRatio} promptChars=${klingInput.prompt.length}`
      );
      const result = await generateImageKling({
        model,
        prompt: klingInput.prompt,
        aspectRatio,
        resolution,
        references: refs,
      });
      // Kling reports what it actually charged, so replace the enqueue-time
      // estimate with the real figure. Kling is the only provider here that does
      // this; everywhere else costCents stays an estimate from the pricing table.
      const actual = klingUnitsToCents(result.unitDeduction);
      if (actual != null) {
        console.log(
          `[image] kling billed ${result.unitDeduction} units = ${actual}¢ ` +
            `for ${id} (estimate was ${costCents}¢)`
        );
        costCents = actual;
      }
      // Download once so the bytes can be both measured and stored. Kling clears
      // hosted results after 30 days, so re-storing is mandatory either way.
      const fetched = await fetch(result.url);
      if (!fetched.ok) {
        throw new Error(
          `Kling produced an image but it could not be downloaded (http ${fetched.status}).`
        );
      }
      const bytes = Buffer.from(await fetched.arrayBuffer());
      // Kling IGNORES aspect_ratio in image-to-image and follows the reference
      // instead (probe-measured — see providers/kling.ts). It also rounds
      // text-to-image output to convenient pixel multiples. Storing the
      // requested ratio would mislabel the card AND give it the wrong shape in
      // the library's masonry, which lays out from this field. So record what
      // actually came back.
      const meta = await sharp(bytes).metadata();
      const measured = nearestKlingAspectRatio(meta.width ?? 0, meta.height ?? 0);
      if (measured && measured !== aspectRatio) {
        console.log(
          `[image] kling returned ${meta.width}x${meta.height} (${measured}), ` +
            `not the requested ${aspectRatio} — storing the measured ratio`
        );
        aspectRatioOut = measured;
      }
      url = await saveBase64(bytes.toString("base64"), "png", id);
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
      aspectRatio: aspectRatioOut,
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
