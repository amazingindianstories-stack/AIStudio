import { NextResponse } from "next/server";
import {
  getVideoTask,
  isModerationMessage,
  MODERATION_MESSAGE,
} from "@/lib/providers/seedance";
import { isHiggsfieldModel, mcpJobStatus } from "@/lib/providers/higgsfield-mcp";
import { isOmniModel, getOmniVideoStatus } from "@/lib/providers/omni";
import { saveBase64, saveFromUrl, readImageAsBase64 } from "@/lib/save-media";
import { getItem, upsertItem } from "@/lib/store-db";
import { isMock } from "@/lib/mock";
import { readPricing } from "@/lib/pricing-db";
import { computeSeedanceTokenCostCents } from "@/lib/pricing";
import { extractLastFrameServer } from "@/lib/video-frame-server";
import { judgeCandidate, judgeIdentity, selectBestCandidate } from "@/lib/middleware/face-judge";
import { persistGenerationFailure } from "@/lib/generation-telemetry";

export const runtime = "nodejs";
// Frame extraction downloads a full candidate video then shells out to
// ffmpeg — real wall-clock work, on top of this route's normal provider
// poll. maxDuration wasn't set here before (implicit default) because a
// single-candidate poll is fast; best-of-N's judging pass is not.
export const maxDuration = 120;

/**
 * Resolves a video best-of-N row (Phase 3.2) — one with `candidateTaskIds`
 * set, meaning queue/execute submitted multiple provider tasks in parallel.
 * Polls every candidate task; only proceeds to judging once ALL have
 * reached a terminal state (succeeded/failed), same "don't act until the
 * provider itself has an answer" principle the single-candidate path below
 * follows for its own age-timeout handling.
 *
 * Returns null when there's nothing to persist yet (still waiting on one or
 * more candidates) so the caller can fall through to its existing
 * still-running response.
 */
async function resolveVideoBestOf(item, agedOut) {
  const allTaskIds = [item.taskId, ...(item.candidateTaskIds ?? [])];
  const results = await Promise.all(
    allTaskIds.map(async (taskId) => {
      try {
        return { taskId, ...(await getVideoTask(taskId)) };
      } catch (e) {
        // A transient poll error on ONE candidate must not fail the whole
        // job — same reasoning the single-candidate path's outer catch
        // block already documents. Reported as "running" so this candidate
        // is simply retried on the next poll instead of prematurely
        // excluding it from judging.
        console.error(`[video best-of-N] poll error for candidate ${taskId}:`, e);
        return { taskId, status: "running" };
      }
    })
  );

  const pending = results.filter((r) => r.status !== "succeeded" && r.status !== "failed");
  if (pending.length > 0) {
    if (agedOut) {
      return {
        ...item,
        status: "failed",
        error: "Generation timed out — not every candidate returned a result in time.",
        candidateTaskIds: null,
        updatedAt: Date.now(),
      };
    }
    return null; // still waiting — nothing to persist yet
  }

  const succeeded = results.filter((r) => r.status === "succeeded" && r.videoUrl);
  if (!succeeded.length) {
    const blocked = results.some((r) => isModerationMessage(r.error || ""));
    return {
      ...item,
      status: "failed",
      error: blocked
        ? MODERATION_MESSAGE
        : results.find((r) => r.error)?.error || "All candidates failed to generate.",
      moderationBlocked: blocked,
      candidateTaskIds: null,
      updatedAt: Date.now(),
    };
  }

  // Reference face: the first uploaded reference image, same one
  // buildVideoDirective's identityLock was told to hold every candidate to.
  // judgeCandidate/judgeIdentity don't require a tight crop — they hand the
  // image straight to a Gemini vision comparison call — so the raw upload
  // works fine as ground truth without running the heavier
  // prompt-assembler/faceCrops pipeline just to get one.
  const refRaw = await readImageAsBase64(item.referenceImages[0]);
  const useComposite = process.env.JUDGE_COMPOSITE === "1";

  const frames = await Promise.all(
    succeeded.map(async (r) => {
      try {
        return { ...r, frame: await extractLastFrameServer(r.videoUrl) };
      } catch (e) {
        console.error(`[video best-of-N] frame extraction failed for ${r.taskId}:`, e);
        return { ...r, frame: null };
      }
    })
  );
  const judged = frames.filter((f) => f.frame);
  // Every extraction failed (e.g. ffmpeg unavailable in this deploy) — fall
  // back to the first successfully-generated candidate rather than losing
  // every billed render to a judging-infrastructure problem.
  const pool = judged.length ? judged : succeeded.map((r) => ({ ...r, frame: null }));

  let winner = pool[0];
  // Winning candidate's judge score (Phase 3.5) — same "persist what the
  // judge said, not just log it" reasoning as queue/execute's image path.
  // Stays null when there was nothing to compare (0 or 1 judged frames).
  let judgeScore = null;
  if (judged.length > 1) {
    if (useComposite) {
      const scores = await Promise.all(
        judged.map((f) => judgeCandidate(refRaw, f.frame))
      );
      const best = selectBestCandidate(scores, 8);
      winner = judged[best];
      judgeScore = scores[best] ?? null;
      console.log(
        `[video best-of-N] composite scores: ` +
          `${scores.map((s) => (s ? `id${s.identity}/pr${s.prominence}/sh${s.sharpness}` : "n/a")).join(", ")} ` +
          `→ picked candidate ${winner.taskId}`
      );
    } else {
      const scores = await Promise.all(judged.map((f) => judgeIdentity(refRaw, f.frame)));
      let best = 0;
      for (let i = 1; i < scores.length; i++) {
        if ((scores[i] ?? -1) > (scores[best] ?? -1)) best = i;
      }
      winner = judged[best];
      judgeScore = scores[best] != null ? { identity: scores[best] } : null;
      console.log(
        `[video best-of-N] identity scores: ${scores.map((s) => s ?? "n/a").join(", ")} ` +
          `→ picked candidate ${winner.taskId}`
      );
    }
  }

  let localUrl = winner.videoUrl;
  try {
    localUrl = await saveFromUrl(winner.videoUrl, "mp4", item.id);
  } catch {
    // fall back to the remote url if download fails
  }

  // costCents was already billed at submission time as the per-candidate
  // estimate × videoBestOf (see queue/execute) — every candidate is a real
  // separately-billed provider task regardless of which one wins, so that
  // total stands. NOT refined against Seedance 2.5's real per-token usage
  // the way the single-candidate path below does: doing that correctly here
  // would mean summing every succeeded candidate's own totalTokens, not just
  // the winner's, and that refinement wasn't built for this first cut.
  return {
    ...item,
    status: "succeeded",
    url: localUrl,
    candidateTaskIds: null,
    judgeScore,
    updatedAt: Date.now(),
  };
}

export async function GET(req) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing id." }, { status: 400 });
  }
  const item = await getItem(id);
  if (!item) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if (item.status === "succeeded" || item.status === "failed") {
    return NextResponse.json(item);
  }

  // Safety net: no provider takes this long — fail instead of spinning forever
  // (e.g. when the stored task id turns out not to be a real job, or when
  // /api/queue/execute died between locking the job "running" and actually
  // submitting it, leaving taskId permanently null).
  const POLL_TIMEOUT_MS = 30 * 60 * 1000;
  const agedOut = !isMock() && Date.now() - item.createdAt > POLL_TIMEOUT_MS;

  // AGE ALONE MUST NEVER FAIL A JOB THE PROVIDER MIGHT HAVE FINISHED.
  //
  // This check used to run here, before the provider was asked, so the first
  // poll after the 30-minute mark failed the row without ever calling BytePlus.
  // Polling is not continuous — it stops when the tab is closed and resumes
  // when the user comes back — so "older than 30 minutes" mostly means "nobody
  // was watching", not "the provider is stuck". A user who closed the tab and
  // returned later had their finished, *billed* video thrown away and replaced
  // with a timeout error, and the row was terminal so nothing ever re-checked.
  //
  // Measured on production: all three rows carrying this error had a real
  // taskId, i.e. every one had been submitted to the provider. Their
  // created→failed gaps were 38.8, 47.4 and 286.1 minutes — all past the
  // threshold, which means the failing poll came after a gap in polling rather
  // than at the 30-minute mark a continuously-polled job would have hit.
  //
  // The timeout now applies only where it cannot destroy a result: below, once
  // the provider itself has said the job is still pending.
  if (!item.taskId) {
    // Nothing to ask — the task was never submitted, so age is all there is.
    if (agedOut) {
      const failed = {
        ...item,
        status: "failed" ,
        error: "Generation timed out — the provider never returned a result.",
        updatedAt: Date.now(),
      };
      await persistGenerationFailure(failed, {
        route: "video_status",
        phase: "missing_task_timeout",
        errorCode: "timeout",
      });
      return NextResponse.json(failed);
    }
    return NextResponse.json(item);
  }

  try {
    // Video best-of-N (Phase 3.2) — only set on native BytePlus rows that
    // queue/execute submitted multiple candidates for. Checked before the
    // mock/Omni/single-candidate branches below since it's an orthogonal
    // concern: a best-of-N row is still, underneath, a native-BytePlus row.
    if (!isMock() && item.candidateTaskIds && item.candidateTaskIds.length > 0) {
      const resolved = await resolveVideoBestOf(item, agedOut);
      if (resolved) {
        if (resolved.status === "failed") {
          await persistGenerationFailure(resolved, {
            route: "video_status",
            phase: "best_of_resolution",
          });
        } else {
          await upsertItem(resolved);
        }
        return NextResponse.json(resolved);
      }
      return NextResponse.json(item); // still waiting on one or more candidates
    }

    if (isMock()) {
      // Pretend it finishes ~6s after creation; "video" reuses the poster image.
      if (Date.now() - item.createdAt > 6000) {
        const done = {
          ...item,
          status: "succeeded" ,
          url: item.poster,
          updatedAt: Date.now(),
        };
        await upsertItem(done);
        return NextResponse.json(done);
      }
      return NextResponse.json(item);
    }

    if (isOmniModel(item.model)) {
      const result = await getOmniVideoStatus(item.taskId);
      if (result.status === "succeeded" && result.videoBase64) {
        // Inline base64 delivery (probe-confirmed) — no remote URL to
        // download; store it directly. This is a billed, non-refetchable
        // payload (Omni doesn't re-serve a completed interaction's video on
        // a later poll), so a single transient storage blip gets one retry
        // before being treated as a terminal failed item — never a silent
        // swallow either way, the user needs to know the generation ran
        // (and was billed) but wasn't saved.
        const ext = (result.mimeType || "").includes("webm") ? "webm" : "mp4";
        let url;
        let saveError;
        for (let attempt = 1; attempt <= 2 && !url; attempt++) {
          try {
            url = await saveBase64(result.videoBase64, ext, item.id);
          } catch (e) {
            saveError = e;
            if (attempt === 1) await new Promise((r) => setTimeout(r, 1000));
          }
        }
        if (url) {
          const done = { ...item, status: "succeeded" , url, updatedAt: Date.now() };
          await upsertItem(done);
          return NextResponse.json(done);
        }
        const failed = {
          ...item,
          status: "failed" ,
          error: `Video generated but failed to save: ${saveError?.message || String(saveError)}`,
          updatedAt: Date.now(),
        };
        await persistGenerationFailure(failed, {
          route: "video_status",
          phase: "omni_storage",
          errorCode: "storage_failed",
        });
        return NextResponse.json(failed);
      }
      if (result.status === "failed") {
        const failed = {
          ...item,
          status: "failed" ,
          error: result.error || "Generation failed.",
          moderationBlocked: result.moderationBlocked,
          updatedAt: Date.now(),
        };
        await persistGenerationFailure(failed, {
          route: "video_status",
          phase: "omni_provider_status",
        });
        return NextResponse.json(failed);
      }
      if (result.status === "succeeded") {
        // Defensive only — getOmniVideoStatus's succeeded branch always
        // resolves videoBase64 or throws (never returns succeeded without
        // one), so this shouldn't be reachable; guarding it anyway so a
        // future change here can't silently persist a "succeeded" item with
        // no url instead of failing loudly.
        const failed = {
          ...item,
          status: "failed" ,
          error: "Omni reported success but returned no video.",
          updatedAt: Date.now(),
        };
        await persistGenerationFailure(failed, {
          route: "video_status",
          phase: "omni_missing_video",
          errorCode: "missing_output",
        });
        return NextResponse.json(failed);
      }
      const updated = { ...item, status: result.status, updatedAt: Date.now() };
      await upsertItem(updated);
      return NextResponse.json(updated);
    }

    // Higgsfield → MCP (returns `url`); native BytePlus Seedance → `videoUrl`.
    const result = isHiggsfieldModel(item.model)
      ? await mcpJobStatus(item.taskId)
      : await getVideoTask(item.taskId);
    const videoUrl =
      (result ).url ?? (result ).videoUrl;
    if (result.status === "succeeded" && videoUrl) {
      // Download to local storage so it survives provider URL expiry.
      let localUrl = videoUrl;
      try {
        localUrl = await saveFromUrl(videoUrl, "mp4", item.id);
      } catch {
        // fall back to the remote url if download fails
      }
      let costCents = item.costCents;
      let costBasis = item.costBasis === "reconciled" ? "reconciled" : "estimated";
      // Seedance 2.5 only — BytePlus bills by tokens, and the finished task
      // reports the real count (usage.total_tokens, see providers/seedance.ts
      // getVideoTask). Same "provider reports its own billing" pattern as
      // Kling's final_unit_deduction in queue/execute/route.ts: overwrite the
      // enqueue-time estimate with the exact figure, or keep the estimate if
      // the count is missing/unparseable.
      if (/seedance 2\.5/i.test(item.model)) {
        const totalTokens = (result ).totalTokens;
        const hadVideoInput = (item.referenceVideos?.length ?? 0) > 0;
        const actual = computeSeedanceTokenCostCents(
          item.model,
          totalTokens,
          hadVideoInput,
          await readPricing()
        );
        if (actual != null) {
          console.log(
            `[video] seedance 2.5 billed ${totalTokens} tokens = ${actual}¢ ` +
              `for ${item.id} (estimate was ${costCents}¢)`
          );
          costCents = actual;
          costBasis = "reconciled";
        }
      }
      const done = {
        ...item,
        status: "succeeded" ,
        url: localUrl,
        costCents,
        costBasis,
        updatedAt: Date.now(),
      };
      await upsertItem(done);
      return NextResponse.json(done);
    }
    if (result.status === "failed") {
      const blocked = isModerationMessage(result.error || "");
      const failed = {
        ...item,
        status: "failed" ,
        error: blocked ? MODERATION_MESSAGE : result.error || "Generation failed.",
        moderationBlocked: blocked,
        updatedAt: Date.now(),
      };
      await persistGenerationFailure(failed, {
        route: "video_status",
        phase: "provider_status",
      });
      return NextResponse.json(failed);
    }
    // Still running/queued. This is the one place the age check is safe: the
    // provider has just told us it has no result, so failing here cannot throw
    // one away.
    if (agedOut) {
      const failed = {
        ...item,
        status: "failed" ,
        error: "Generation timed out — the provider never returned a result.",
        updatedAt: Date.now(),
      };
      await persistGenerationFailure(failed, {
        route: "video_status",
        phase: "provider_timeout",
        errorCode: "timeout",
      });
      return NextResponse.json(failed);
    }
    const updated = { ...item, status: result.status, updatedAt: Date.now() };
    await upsertItem(updated);
    return NextResponse.json(updated);
  } catch (e) {
    console.error("[video status poll error]:", e);
    // NOTE: the age check above is deliberately NOT applied here. A row whose
    // polls always throw therefore stays "running" indefinitely, which is the
    // accepted cost of never failing a job on a network blip — losing a
    // finished, billed render is strictly worse than a stuck spinner, and the
    // spinner is visible while the loss is silent.
    // Transient poll error (network blip, provider 502/503, a momentary MCP
    // socket drop) — the DB row is untouched, still "running"/"queued". The
    // response must NOT claim status:"failed": the client's pollVideo() only
    // reads this JSON body and stops polling the instant it sees a terminal
    // status (see store.js), with no way to tell "really failed" apart from
    // "the poll itself failed". Reporting failure here would silently lose a
    // render that finishes seconds later on the provider's side — this was
    // shipped as debug scaffolding ("temporarily mark it as failed... so the
    // user can see it") and never cleaned up.
    //
    // Deliberately omitting `id` from the body (rather than spreading
    // `...item`) is what makes this safe: pollVideo() only patches state and
    // evaluates the terminal-status check inside `if (item?.id)`, so a body
    // with no `id` falls through to its trailing retry timer untouched. The
    // 502 status is for logs/monitoring, not client branching.
    return NextResponse.json(
      { error: `Poll error: ${e?.message || String(e)}`, transientError: true },
      { status: 502 }
    );
  }
}
