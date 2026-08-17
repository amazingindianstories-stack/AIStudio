import { NextResponse } from "next/server";
import {
  getVideoTask,
  isModerationMessage,
  MODERATION_MESSAGE,
} from "@/lib/providers/seedance";
import { isHiggsfieldModel, mcpJobStatus } from "@/lib/providers/higgsfield-mcp";
import { isOmniModel, getOmniVideoStatus } from "@/lib/providers/omni";
import { saveBase64, saveFromUrl } from "@/lib/save-media";
import { getItem, upsertItem } from "@/lib/store-db";
import { isMock } from "@/lib/mock";
import { readPricing } from "@/lib/pricing-db";
import { computeSeedanceTokenCostCents } from "@/lib/pricing";

export const runtime = "nodejs";

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
      await upsertItem(failed);
      return NextResponse.json(failed);
    }
    return NextResponse.json(item);
  }

  try {
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
        await upsertItem(failed);
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
        await upsertItem(failed);
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
        await upsertItem(failed);
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
        }
      }
      const done = {
        ...item,
        status: "succeeded" ,
        url: localUrl,
        costCents,
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
      await upsertItem(failed);
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
      await upsertItem(failed);
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
