import { NextResponse } from "next/server";
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
  prepKlingReference,
} from "@/lib/providers/kling";
import { isOmniModel, createOmniVideoTask } from "@/lib/providers/omni";
import { supportsSeed, supportsVideoBestOf } from "@/lib/config";
import { buildKlingInput } from "@/lib/kling-input";
import { resolveReferences, resolveVideoReferences } from "@/lib/mentions";
import {
  readImageAsBase64,
} from "@/lib/save-media";
import {
  saveBase64WithMetadata,
  saveBufferWithMetadata,
  saveFromUrlWithMetadata,
} from "@/lib/generated-media-persistence";
import { signStoredRef } from "@/lib/storage";
import { upsertItem, lockJob, getItem, getQueuePosition } from "@/lib/store-db";
import { isMock, mockPlaceholder } from "@/lib/mock";
import { crispen, prepReference } from "@/lib/middleware/image-prep";
import { judgeCandidate, judgeIdentity, selectBestCandidate } from "@/lib/middleware/face-judge";
import { assemblePrompt } from "@/lib/prompt-assembler";
import { readAssets } from "@/lib/assets-db";
import { getSession } from "@/lib/auth";
import { klingUnitsToCents } from "@/lib/pricing";
import { getModelDefinition } from "@/lib/model-registry";
import { boundedBestOf, generateAndSpoolCandidates, readSpooledBase64 } from "@/lib/best-of-spool";
import { submitVideoCandidates } from "@/lib/video-submissions";
import {
  emitGenerationEvent,
  persistGenerationFailure,
} from "@/lib/generation-telemetry";
import {
  abortableDelay,
  settleQueueExecution,
  throwIfAborted,
} from "@/lib/queue-execution-deadline";

import sharp from "sharp";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
// Keep in sync with STALE_RUNNING_MS in src/lib/store-db.js, which MUST stay
// comfortably above this value or the reaper will fail jobs that are still
// legitimately running. (Next requires a statically analysable literal here, so
// the two constants can't share an import.)
export const maxDuration = 300;

function resolutionToImageSize(res) {
  if (res === "4K") return "4K";
  if (res === "2K" || res === "1080p") return "2K";
  return "1K";
}

/** Turn stored clip refs into short-lived URLs the provider can fetch.
 *  A ref that is already an absolute URL is passed through untouched. */
async function signVideoRefs(refs, signal) {
  const out = [];
  for (const ref of refs) {
    throwIfAborted(signal);
    try {
      const signed = await signStoredRef(ref);
      out.push(signed ?? ref);
    } catch (e) {
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
async function toProviderDataUrls(refs, signal) {
  const out = [];
  for (const ref of refs) {
    throwIfAborted(signal);
    const raw = await readImageAsBase64(ref, signal);
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
async function submitVideo(base, signal) {
  const { id, prompt, aspectRatio, resolution, duration, model, seed, videoBestOf } = base;

  if (isMock()) {
    throwIfAborted(signal);
    return {
      ...base,
      taskId: `mock-${id}`,
      poster: await mockPlaceholder(id, prompt, aspectRatio, model),
      status: "running",
      updatedAt: Date.now(),
    };
  }

  let taskId;
  const refUpdates = {};
  if (isOmniModel(model)) {
    // Same context-engineering path Nano Banana Pro uses for images — role-
    // labeled reference groups + identity tiles + shot-spec framing/negative
    // codas — instead of a flat hand-rolled prompt (see omni-input.js).
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
      signal,
    });
  } else if (isHiggsfieldModel(model)) {
    // Higgsfield (Seedance 2.0/Mini) via the official MCP — supports MULTIPLE
    // reference images natively (image_references), no collage workaround.
    const refs = base.referenceImages ?? [];
    const mediaIds = [];

    if (!refs.length) {
      console.log(
        "[video] No reference image provided for Seedance. Auto-generating base frame via Gemini (T2V fallback)..."
      );
      const { uploadBase64 } = await import("@/lib/storage");
      const genRes = await generateImageGemini({
        assembled: { instruction: prompt, groups: [] },
        aspectRatio,
        signal,
      });
      // Save the generated frame so the user can see it in their history.
      const ext = genRes.mimeType.split("/")[1] || "png";
      throwIfAborted(signal);
      const autoRefUrl = await uploadBase64(genRes.base64, `references/${id}-auto.${ext}`, ext);
      refUpdates.referenceImages = [autoRefUrl];
      mediaIds.push(await mcpUploadImage(genRes.base64, genRes.mimeType, { signal }));
    } else {
      for (const ref of refs) {
        const raw = await readImageAsBase64(ref, signal);
        const { mimeType, data } = await prepReference(raw.mimeType, raw.data);
        mediaIds.push(await mcpUploadImage(data, mimeType, { signal }));
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
      signal,
    });
  } else {
    // Native BytePlus ModelArk Seedance 2.0. resolveReferences maps @imgN to
    // uploads by position, so the inlined list must keep referenceImages' order.
    const inlined = await toProviderDataUrls(base.referenceImages ?? [], signal);
    const signedRefVideos = await signVideoRefs(
      resolveVideoReferences(prompt, base.referenceVideos ?? []),
      signal
    );
    const resolvedRefs = resolveReferences(prompt, inlined);
    // Multi-shot chaining (Phase 3.3) — reuses the same stored-ref → inline
    // data-URL materialisation referenceImages already goes through; a
    // continuation frame is stored exactly like a reference image (see
    // generate/video/route.js), just kept in its own column instead of the
    // referenceImages array so it can't be mistaken for one of the tagged
    // @imgN references or counted against MAX_REFERENCE_VIDEOS-style limits.
    const [firstFrameDataUrl] = base.continuationFrameUrl
      ? await toProviderDataUrls([base.continuationFrameUrl], signal)
      : [];
    console.log(
      `[video] BytePlus seedance with ${inlined.length} reference image(s), ` +
        `bestOf=${videoBestOf ?? 1}, continuation=${!!firstFrameDataUrl}`
    );
    const taskInput = (candidateSeed) => ({
      prompt,
      modelDisplay: model,
      ratio: aspectRatio,
      resolution,
      duration,
      references: resolvedRefs,
      // Signed here, at the last possible moment, and never persisted or sent
      // to the browser. BytePlus fetches the clip itself and /api/media/… is
      // session-gated, so a signed URL is the only thing it can actually read.
      referenceVideoUrls: signedRefVideos,
      // Read off the row, not off this request: /api/generate/video only
      // enqueues, so the user's choice reaches the provider through the
      // persisted column and nothing else.
      generateAudio: base.generateAudio === true,
      // Seedance 2.5 only — Edit/Extend an attached clip. Same "off the row,
      // not off this request" reasoning as generateAudio above.
      taskMode: base.videoTaskMode,
      // Reproducibility seed (Phase 3.1) — native BytePlus only; supportsSeed()
      // never generates one for Omni/Higgsfield, so this is null on those paths
      // and createVideoTask's own typeof guard omits it from the request body.
      seed: candidateSeed,
      // Multi-shot chaining (Phase 3.3) — see createVideoTask's own header
      // for the evidence caveat (third-party tutorial, not official docs).
      firstFrame: firstFrameDataUrl ? { dataUrl: firstFrameDataUrl } : undefined,
      signal,
    });

    if ((videoBestOf ?? 1) > 1) {
      // Video best-of-N (Phase 3.2), native BytePlus only — supportsVideoBestOf
      // scopes this. Submit N tasks in parallel, same per-candidate seed-offset
      // reasoning as image best-of-N (queue/execute's image branch): an
      // identical seed across candidates would collapse them to N renders of
      // the same result instead of N genuinely different ones for the judge
      // to pick from.
      // Keep every task the provider accepted. ModelArk has no cancellation
      // endpoint, so failing the row after a partial submission would orphan
      // billed renders. A partial set remains a valid running job and its
      // estimate is reduced to the number actually accepted.
      const submissions = await submitVideoCandidates({
        count: videoBestOf,
        totalCostCents: base.costCents,
        seed,
        submit: (candidateSeed) => createVideoTask(taskInput(candidateSeed)),
      });
      taskId = submissions.acceptedTaskIds[0];
      refUpdates.candidateTaskIds = submissions.acceptedTaskIds.slice(1);
      refUpdates.costCents = submissions.costCents;
      if (submissions.rejectedCount) {
        emitGenerationEvent({
          event: "generation_partial_submission",
          route: "queue_execute",
          phase: "provider_submission",
          item: base,
          errorCode: "partial_submission",
          requestedCount: videoBestOf,
          acceptedCount: submissions.acceptedTaskIds.length,
          rejectedCount: submissions.rejectedCount,
        }, console.warn);
      }
    } else {
      taskId = await createVideoTask(taskInput(seed));
    }
  }
  return { ...base, ...refUpdates, taskId, status: "running", updatedAt: Date.now() };
}

export async function POST(req) {
  const body = await req.json().catch(() => ({}));
  const id = body.id;

  if (!id) {
    return NextResponse.json({ error: "Job ID is required." }, { status: 400 });
  }

  const user = await getSession();
  if (!user) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  // Admission is checked before the lock is acquired, not after: lockJob()
  // flips the row to "running" unconditionally and there is no unlock path
  // to undo that, so rejecting an inadmissible job afterward would strand it
  // "running" until the stale-job reaper caught it minutes later. A plain
  // read has no such side effect.
  //
  // This used to be an ownership check instead (only the job's owner or an
  // admin could call execute). That was addressing the wrong risk: the real
  // hazard here was never "the wrong teammate ran a ready job" — it's that
  // this route had NO admission control of its own. getQueuePosition() (also
  // used by /api/queue/status) is where MAX_CONCURRENT and the Gemini
  // spend-window gate actually live; this route used to trust the client to
  // only call it once /api/queue/status reported position 0, which any
  // direct POST (devtools, a retry bug, a race) could simply skip, bypassing
  // both the concurrency cap and the spend throttle spend-window.js exists to
  // enforce. Re-running the same admission check here closes that regardless
  // of who's calling — including the legitimate case of a teammate's tab
  // adopting a job whose owner's tab has gone away (see adoptOrphanedJobs in
  // store.js), which an ownership-only gate would have blocked outright.
  const position = await getQueuePosition(id);
  if (!position) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }
  if (position.position !== 0) {
    // Not actually our turn (or the spend window won't admit it yet). Report
    // the same shape /api/queue/status uses so the client's existing
    // heldForBudget/backoff handling applies uniformly — see pollQueue() in
    // store.js.
    return NextResponse.json({ ...position, notAdmitted: true });
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
  let costBasis = base.costBasis === "reconciled" ? "reconciled" : "estimated";
  // Reproducibility seed (Phase 3.1). Only filled in for models supportsSeed
  // actually confirms support for (today: Gemini/NBP here, native BytePlus
  // Seedance in the video branch below) — every other model keeps whatever
  // was already on the row (normally null) untouched. A fresh int32 is
  // generated here, not left to the provider's own default, so every
  // supported generation ends up with a concrete seed to regenerate from —
  // "regenerate with same seed" has nothing to reuse against a null.
  let seed = base.seed ?? null;
  if (supportsSeed(model) && seed == null) {
    seed = Math.floor(Math.random() * 2147483647);
  }
  // Every provider result is measured from its persisted bytes. Inspection is
  // fail-open, so this remains the requested ratio if metadata cannot be read.
  let aspectRatioOut = aspectRatio;

  // Video best-of-N (Phase 3.2). Gated on three independent things, all of
  // which must hold: the model (native BytePlus only, supportsVideoBestOf),
  // the operator flag (VIDEO_BEST_OF unset = off by default — see
  // video-frame-server.js for why), and a reference image actually being
  // attached (the judge scores candidates against referenceImages[0]; with
  // no reference there is nothing to judge identity against, and
  // best-of-N without a judge would just be N-times the cost for a
  // coin-flip pick).
  const videoBestOf =
    base.kind === "video" &&
    supportsVideoBestOf(model) &&
    process.env.VIDEO_BEST_OF &&
    (base.referenceImages ?? []).length > 0
      ? Math.min(3, Math.max(2, Number(process.env.VIDEO_BEST_OF) || 2))
      : 1;
  if (videoBestOf > 1) {
    // Bill for what's actually being submitted — every candidate is a real,
    // separately billed provider task, unlike the image best-of-N path
    // (where costCents is corrected AFTER resolution against however many
    // candidates actually settled). Video's status-poll route can't cheaply
    // "undo" a submitted-but-unjudged task the way a rejected Promise.allSettled
    // entry is simply excluded on the image side, so this bills for the
    // full requested N up front.
    costCents = costCents * videoBestOf;
  }

  // Video: submit the provider task (remote render) and return the running
  // item — the client's pollVideo then drives /api/generate/video/status.
  // Living here (not in the enqueue route) keeps concurrent renders inside
  // the queue's per-kind cap.
  if (base.kind === "video") {
    return settleQueueExecution({
      work: (signal) => submitVideo({ ...base, seed, videoBestOf, costCents }, signal),
      onSuccess: async (running) => {
        await upsertItem(running);
        return NextResponse.json(running);
      },
      onFailure: async (e) => {
        const failed = {
          ...base,
          status: "failed",
          error: e?.message || "Video task creation failed.",
          moderationBlocked: e?.code === "moderation",
          updatedAt: Date.now(),
        };
        await persistGenerationFailure(failed, {
          route: "queue_execute",
          phase: "video_submission",
          errorCode: e?.code,
        });
        return NextResponse.json(failed);
      },
    });
  }

  return settleQueueExecution({
    work: async (signal) => {
    let url;
    // Winning candidate's judge score (Phase 3.5), persisted onto the row
    // below so a later "flag this generation" carries real evidence, not
    // just a prompt/model snapshot — see schema.js's `judgeScore` comment.
    // Declared up here (not inside the Gemini branch below) so it's in scope
    // for every branch's `done` object; stays null except when Gemini
    // best-of-N judging actually ran.
    let judgeScore = null;
    if (isMock()) {
      await abortableDelay(700, signal);
      url = await mockPlaceholder(id, prompt, aspectRatio, model);
    } else if (isHiggsfieldModel(model)) {
      // Higgsfield image via the MCP — Soul (photoreal, one ref, `quality`)
      // or Nano Banana Pro (all refs, `resolution` 1k/2k/4k). Upload refs,
      // submit, then poll the job to completion.
      const assembled = await assemblePrompt(prompt, await readAssets(), referenceImages ?? []);
      const isNanoBanana = getModelDefinition(model)?.higgsfieldTool === "nano-banana";
      const refs = isNanoBanana
        ? referenceImages ?? []
        : (referenceImages ?? []).slice(0, 1);
      let mediaIds;
      if (refs.length) {
        mediaIds = [];
        for (const ref of refs) {
          const raw = await readImageAsBase64(ref, signal);
          const { mimeType, data } = await prepReference(raw.mimeType, raw.data);
          mediaIds.push(await mcpUploadImage(data, mimeType, { signal }));
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
        signal,
      });
      const done = await mcpAwaitJob(jobId, { signal });
      if (done.status !== "succeeded" || !done.url) {
        throw new Error(done.error || "Higgsfield image generation failed.");
      }
      // Persist Higgsfield's hosted result locally so it survives URL expiry.
      const saved = await saveFromUrlWithMetadata(done.url, "png", id, {
        kind: "image",
        model,
        requestedAspectRatio: aspectRatio,
      }, signal);
      url = saved.url;
      aspectRatioOut = saved.aspectRatio;
    } else if (isKlingModel(model)) {
      // Kling takes ONE reference image and ONE prompt string on this endpoint
      // (see providers/kling.js). buildKlingInput adapts the assembled payload
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
      }, { signal });
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
        costBasis = "reconciled";
      }
      // Download once so the bytes can be both measured and stored. Kling clears
      // hosted results after 30 days, so re-storing is mandatory either way.
      const fetched = await fetch(result.url, { signal });
      if (!fetched.ok) {
        throw new Error(
          `Kling produced an image but it could not be downloaded (http ${fetched.status}).`
        );
      }
      const bytes = Buffer.from(await fetched.arrayBuffer());
      throwIfAborted(signal);
      const saved = await saveBufferWithMetadata(bytes, "png", id, {
        kind: "image",
        model,
        requestedAspectRatio: aspectRatio,
      });
      url = saved.url;
      aspectRatioOut = saved.aspectRatio;
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
      const input = {
        assembled,
        aspectRatio,
        imageSize: requestedSize,
        modelDisplay: model,
        seed,
        signal,
      };
      // Best-of-N: generation is stochastic (identity swings 5–65 on the same
      // config), so when a face is locked we generate N candidates serially,
      // auto-judge each against the reference face and keep the best. This is
      // the measured lever — single-pass tricks and face-fix second passes
      // both failed the bake-off.
      const bestOf = assembled.judgeFace
        ? boundedBestOf(process.env.FACE_BEST_OF, requestedSize)
        : 1;
      console.log(
        `[image] model=${model} uploads=${referenceImages?.length ?? 0} ` +
          `groups=${assembled.groups.length} refImages=${refImageCount} bestOf=${bestOf} ` +
          `imageSize=${requestedSize}`
      );
      let base64;
      let mimeType;
      if (bestOf > 1) {
        // Per-candidate seed offset, not the same seed repeated N times — an
        // identical seed across parallel candidates would (to the extent NBP's
        // seed determinism holds at all — see gemini.js's own doc comment on
        // the field) collapse best-of-N's diversity to a single image N times
        // over, defeating the whole point of the judge picking among distinct
        // renders. Offsetting by candidate index keeps every candidate
        // individually reproducible while still varying between candidates.
        const spoolDir = await mkdtemp(path.join(os.tmpdir(), "veevee-best-of-"));
        try {
          const { candidates, errors } = await generateAndSpoolCandidates({
            count: bestOf,
            directory: spoolDir,
            signal,
            generate: (i) => generateImageGemini({
              ...input,
              seed: seed != null ? seed + i : undefined,
            }),
          });
          if (!candidates.length) throw errors[0] ?? new Error("Image generation failed.");
          // Bill what actually completed, including candidates not selected.
          costCents = costCents * candidates.length;
          const scores = [];
          for (const candidate of candidates) {
            const data = await readSpooledBase64(candidate);
            scores.push(process.env.JUDGE_COMPOSITE === "1"
              ? await judgeCandidate(assembled.judgeFace, { mimeType: candidate.mimeType, data }, signal)
              : await judgeIdentity(assembled.judgeFace, { mimeType: candidate.mimeType, data }, signal));
          }
          let best;
          if (process.env.JUDGE_COMPOSITE === "1") {
            // Widened judge: identity + subject prominence + face sharpness in
            // one call each, picked subject to an identity floor so identity
            // never regresses vs the identity-only picker below.
            best = selectBestCandidate(scores, 8);
            console.log(
              `[image] best-of-${candidates.length} composite scores: ` +
                `${scores
                  .map((s) => (s ? `id${s.identity}/pr${s.prominence}/sh${s.sharpness}` : "n/a"))
                  .join(", ")} → picked #${best + 1}`
            );
          } else {
            best = 0;
            for (let i = 1; i < scores.length; i++) {
              if ((scores[i] ?? -1) > (scores[best] ?? -1)) best = i;
            }
            console.log(
              `[image] best-of-${candidates.length} identity scores: ` +
                `${scores.map((s) => s ?? "n/a").join(", ")} → picked #${best + 1}`
            );
          }
          judgeScore = process.env.JUDGE_COMPOSITE === "1"
            ? scores[best] ?? null
            : scores[best] != null ? { identity: scores[best] } : null;
          mimeType = candidates[best].mimeType;
          base64 = await readSpooledBase64(candidates[best]);
        } finally {
          await rm(spoolDir, { recursive: true, force: true });
        }
      } else {
        ({ base64, mimeType } = await generateImageGemini(input));
      }

      if (process.env.POST_CRISPEN === "1") {
        throwIfAborted(signal);
        ({ data: base64, mimeType } = await crispen(mimeType, base64));
      }
      const ext = mimeType.includes("jpeg") ? "jpg" : "png";
      throwIfAborted(signal);
      const saved = await saveBase64WithMetadata(base64, ext, id, {
        kind: "image",
        model,
        requestedAspectRatio: aspectRatio,
      });
      url = saved.url;
      aspectRatioOut = saved.aspectRatio;
    }
    const done = {
      ...base,
      status: "succeeded",
      url,
      aspectRatio: aspectRatioOut,
      costCents, // includes the NB2 face-refine pass when it ran
      costBasis,
      seed, // the freshly generated/reused value, not base's stale one
      judgeScore, // null unless best-of-N judging ran (see above)
      updatedAt: Date.now(),
    };
    throwIfAborted(signal);
    return done;
    },
    onSuccess: async (done) => {
      await upsertItem(done);
      return NextResponse.json(done);
    },
    onFailure: async (e) => {
      const failed = {
        ...base,
        status: "failed",
        error: e?.message || "Image generation failed.",
        updatedAt: Date.now(),
      };
      await persistGenerationFailure(failed, {
        route: "queue_execute",
        phase: "image_execution",
        errorCode: e?.code,
      });
      return NextResponse.json(failed);
    },
  });
}
