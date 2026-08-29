import {
  getVideoTask,
  isModerationMessage,
  MODERATION_MESSAGE,
} from "./providers/seedance";
import { isHiggsfieldModel, mcpJobStatus } from "./providers/higgsfield-mcp";
import { isOmniModel, getOmniVideoStatus } from "./providers/omni";
import { readImageAsBase64 } from "./save-media";
import {
  saveBase64WithMetadata,
  saveFromUrlWithMetadata,
} from "./generated-media-persistence";
import { isMock } from "./mock";
import { readPricing } from "./pricing-db";
import { computeSeedanceTokenCostCents } from "./pricing";
import { extractLastFrameServer } from "./video-frame-server";
import { judgeCandidate, judgeIdentity, selectBestCandidate } from "./middleware/face-judge";
import { emitGenerationEvent } from "./generation-telemetry";
import { getModelDefinition } from "./model-registry";
import {
  clearVideoPollErrors,
  compareAndSetVideoOutcome,
  recordVideoPollError,
} from "./video-poll-db";
import { retryAfterMsForPollErrors } from "./video-poll-backoff";

const defaults = {
  now: () => Date.now(),
  isMock,
  isOmniModel,
  isHiggsfieldModel,
  getVideoTask,
  getOmniVideoStatus,
  mcpJobStatus,
  readImageAsBase64,
  saveBase64WithMetadata,
  saveFromUrlWithMetadata,
  readPricing,
  computeSeedanceTokenCostCents,
  extractLastFrameServer,
  judgeCandidate,
  judgeIdentity,
  selectBestCandidate,
  getModelDefinition,
  clearVideoPollErrors,
  compareAndSetVideoOutcome,
  recordVideoPollError,
  emitGenerationEvent,
  delay: (ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Video poll deadline exceeded."));
    }, { once: true });
  }),
};

function expected(item) {
  return {
    id: item.id,
    status: item.status,
    updatedAt: item.updatedAt,
    taskId: item.taskId,
  };
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error("Video poll deadline exceeded.");
}

function terminalUpdates(item, next) {
  return {
    status: next.status,
    url: next.url ?? null,
    aspectRatio: next.aspectRatio ?? item.aspectRatio,
    error: next.error ?? null,
    moderationBlocked: next.moderationBlocked ?? null,
    candidateTaskIds: Object.hasOwn(next, "candidateTaskIds")
      ? next.candidateTaskIds
      : item.candidateTaskIds ?? null,
    judgeScore: Object.hasOwn(next, "judgeScore")
      ? next.judgeScore
      : item.judgeScore ?? null,
    costCents: next.costCents ?? item.costCents ?? 0,
    costBasis: next.costBasis ?? item.costBasis ?? "estimated",
    updatedAt: next.updatedAt,
  };
}

async function persistTerminal(item, next, context) {
  const { deps, signal, source } = context;
  throwIfAborted(signal);
  const persisted = await deps.compareAndSetVideoOutcome(
    expected(item), terminalUpdates(item, next)
  );
  if (!persisted) return { kind: "raced" };
  if (persisted.status === "failed" && source !== "cron") {
    deps.emitGenerationEvent({
      event: "generation_failure",
      route: "video_status",
      phase: context.phase,
      item: persisted,
      persisted: true,
      errorCode: context.errorCode,
    });
  }
  return { kind: persisted.status, item: persisted };
}

async function clearAfterProviderResponse(item, context) {
  throwIfAborted(context.signal);
  const persisted = await context.deps.clearVideoPollErrors(expected(item));
  return persisted ? { kind: "pending", item: persisted } : { kind: "raced" };
}

async function resolveVideoBestOf(item, context) {
  const { deps, signal } = context;
  const results = [];
  for (const taskId of [item.taskId, ...(item.candidateTaskIds ?? [])]) {
    throwIfAborted(signal);
    results.push({ taskId, ...(await deps.getVideoTask(taskId, { signal })) });
  }
  if (results.some((result) => !["succeeded", "failed"].includes(result.status))) {
    return clearAfterProviderResponse(item, context);
  }

  const succeeded = results.filter((result) => result.status === "succeeded" && result.videoUrl);
  if (!succeeded.length) {
    const blocked = results.some((result) => isModerationMessage(result.error || ""));
    return persistTerminal(item, {
      status: "failed",
      error: blocked ? MODERATION_MESSAGE : results.find((result) => result.error)?.error || "All candidates failed to generate.",
      moderationBlocked: blocked,
      candidateTaskIds: null,
      updatedAt: deps.now(),
    }, { ...context, phase: "best_of_resolution" });
  }

  let winner = succeeded[0];
  let judgeScore = null;
  const reference = item.referenceImages?.[0]
    ? await deps.readImageAsBase64(item.referenceImages[0])
    : null;
  if (reference) {
    const frames = [];
    for (const result of succeeded) {
      try {
        frames.push({ ...result, frame: await deps.extractLastFrameServer(result.videoUrl) });
      } catch {
        frames.push({ ...result, frame: null });
      }
    }
    const judged = frames.filter((result) => result.frame);
    if (judged.length > 1) {
      if (process.env.JUDGE_COMPOSITE === "1") {
        const scores = [];
        for (const result of judged) scores.push(await deps.judgeCandidate(reference, result.frame, signal));
        const best = deps.selectBestCandidate(scores, 8);
        winner = judged[best];
        judgeScore = scores[best] ?? null;
      } else {
        const scores = [];
        for (const result of judged) scores.push(await deps.judgeIdentity(reference, result.frame, signal));
        let best = 0;
        for (let index = 1; index < scores.length; index++) {
          if ((scores[index] ?? -1) > (scores[best] ?? -1)) best = index;
        }
        winner = judged[best];
        judgeScore = scores[best] == null ? null : { identity: scores[best] };
      }
    }
  }

  let url = winner.videoUrl;
  let aspectRatio = item.aspectRatio;
  try {
    const saved = await deps.saveFromUrlWithMetadata(url, "mp4", item.id, {
      kind: "video", model: item.model, requestedAspectRatio: item.aspectRatio,
    });
    url = saved.url;
    aspectRatio = saved.aspectRatio;
  } catch {
    // The provider URL remains usable when durable storage has a transient issue.
  }
  return persistTerminal(item, {
    status: "succeeded", url, aspectRatio, candidateTaskIds: null, judgeScore,
    updatedAt: deps.now(),
  }, { ...context, phase: "best_of_resolution" });
}

async function advanceOmni(item, result, context) {
  const { deps, signal } = context;
  if (result.status === "succeeded" && result.videoBase64) {
    const ext = (result.mimeType || "").includes("webm") ? "webm" : "mp4";
    let saved;
    let saveError;
    for (let attempt = 0; attempt < 2 && !saved; attempt++) {
      try {
        throwIfAborted(signal);
        saved = await deps.saveBase64WithMetadata(result.videoBase64, ext, item.id, {
          kind: "video", model: item.model, requestedAspectRatio: item.aspectRatio,
        });
      } catch (error) {
        saveError = error;
        if (attempt === 0) await deps.delay(1_000, signal);
      }
    }
    if (saved) {
      return persistTerminal(item, {
        status: "succeeded", url: saved.url, aspectRatio: saved.aspectRatio,
        updatedAt: deps.now(),
      }, { ...context, phase: "omni_provider_status" });
    }
    return persistTerminal(item, {
      status: "failed",
      error: `Video generated but failed to save: ${saveError?.message || String(saveError)}`,
      updatedAt: deps.now(),
    }, { ...context, phase: "omni_storage", errorCode: "storage_failed" });
  }
  if (result.status === "failed") {
    return persistTerminal(item, {
      status: "failed", error: result.error || "Generation failed.",
      moderationBlocked: result.moderationBlocked, updatedAt: deps.now(),
    }, { ...context, phase: "omni_provider_status" });
  }
  if (result.status === "succeeded") {
    return persistTerminal(item, {
      status: "failed", error: "Omni reported success but returned no video.",
      updatedAt: deps.now(),
    }, { ...context, phase: "omni_missing_video", errorCode: "missing_output" });
  }
  return clearAfterProviderResponse(item, context);
}

async function advanceStandard(item, result, context) {
  const { deps, signal } = context;
  const videoUrl = result.url ?? result.videoUrl;
  if (result.status === "succeeded" && videoUrl) {
    let url = videoUrl;
    let aspectRatio = item.aspectRatio;
    try {
      const saved = await deps.saveFromUrlWithMetadata(videoUrl, "mp4", item.id, {
        kind: "video", model: item.model, requestedAspectRatio: item.aspectRatio,
      });
      url = saved.url;
      aspectRatio = saved.aspectRatio;
    } catch {
      // Keep the provider URL rather than losing a conclusive success.
    }
    let costCents = item.costCents;
    let costBasis = item.costBasis === "reconciled" ? "reconciled" : "estimated";
    if (deps.getModelDefinition(item.model)?.usageCost === "seedance-token") {
      const actual = deps.computeSeedanceTokenCostCents(
        item.model,
        result.totalTokens,
        (item.referenceVideos?.length ?? 0) > 0,
        await deps.readPricing()
      );
      if (actual != null) {
        costCents = actual;
        costBasis = "reconciled";
      }
    }
    throwIfAborted(signal);
    return persistTerminal(item, {
      status: "succeeded", url, aspectRatio, costCents, costBasis,
      updatedAt: deps.now(),
    }, { ...context, phase: "provider_status" });
  }
  if (result.status === "succeeded") {
    return persistTerminal(item, {
      status: "failed", error: "Provider reported success but returned no video.",
      updatedAt: deps.now(),
    }, { ...context, phase: "provider_missing_video", errorCode: "missing_output" });
  }
  if (result.status === "failed") {
    const blocked = isModerationMessage(result.error || "");
    return persistTerminal(item, {
      status: "failed",
      error: blocked ? MODERATION_MESSAGE : result.error || "Generation failed.",
      moderationBlocked: blocked,
      updatedAt: deps.now(),
    }, { ...context, phase: "provider_status" });
  }
  return clearAfterProviderResponse(item, context);
}

/**
 * Shared browser/cron state machine. It never submits work and never converts
 * a timeout, transport/auth failure, or retryable provider response into a
 * terminal generation state.
 */
export async function advanceVideoStatus(item, {
  source = "browser",
  signal,
  dependencies,
} = {}) {
  const deps = { ...defaults, ...dependencies };
  const context = { deps, signal, source };
  if (["succeeded", "failed"].includes(item.status)) return { kind: item.status, item };
  if (!item.taskId) return { kind: "pending", item };

  try {
    throwIfAborted(signal);
    if (!deps.isMock() && item.candidateTaskIds?.length) {
      return await resolveVideoBestOf(item, context);
    }
    if (deps.isMock()) {
      if (deps.now() - item.createdAt <= 6_000) return { kind: "pending", item };
      return await persistTerminal(item, {
        status: "succeeded", url: item.poster, updatedAt: deps.now(),
      }, { ...context, phase: "mock_status" });
    }
    if (deps.isOmniModel(item.model)) {
      const result = await deps.getOmniVideoStatus(item.taskId, { signal });
      return await advanceOmni(item, result, context);
    }
    const result = deps.isHiggsfieldModel(item.model)
      ? await deps.mcpJobStatus(item.taskId, { signal })
      : await deps.getVideoTask(item.taskId, { signal });
    return await advanceStandard(item, result, context);
  } catch (_error) {
    const health = await deps.recordVideoPollError(expected(item), deps.now());
    if (!health) return { kind: "raced" };
    return {
      kind: "poll_error",
      pollErrorCount: health.pollErrorCount,
      retryAfterMs: retryAfterMsForPollErrors(health.pollErrorCount),
    };
  }
}
