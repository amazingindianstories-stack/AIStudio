import { selectStaleVideoPollCandidates } from "./video-poll-db";
import { advanceVideoStatus } from "./video-status-advancement";

export const VIDEO_RECONCILIATION_STALE_MS = 45 * 60 * 1000;
export const VIDEO_RECONCILIATION_LIMIT = 5;
export const VIDEO_RECONCILIATION_DEADLINE_MS = 40_000;

function emptyCounts() {
  return { ok: true, checked: 0, succeeded: 0, failed: 0, pending: 0, pollErrors: 0, raced: 0 };
}

function raceAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); }
    );
  });
}

/** Bounded, sequential reconciliation with an aggregate-only result. */
export async function runVideoReconciliation({
  now = Date.now(),
  deadlineMs = VIDEO_RECONCILIATION_DEADLINE_MS,
  select = selectStaleVideoPollCandidates,
  advance = advanceVideoStatus,
} = {}) {
  const counts = emptyCounts();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("reconciliation deadline")), deadlineMs);
  try {
    const rows = await raceAbort(select({
      before: now - VIDEO_RECONCILIATION_STALE_MS,
      limit: VIDEO_RECONCILIATION_LIMIT,
    }), controller.signal);
    for (const item of rows.slice(0, VIDEO_RECONCILIATION_LIMIT)) {
      if (controller.signal.aborted) { counts.ok = false; break; }
      counts.checked += 1;
      let outcome;
      try {
        outcome = await raceAbort(advance(item, {
          source: "cron",
          signal: controller.signal,
        }), controller.signal);
      } catch {
        counts.ok = false;
        counts.pollErrors += 1;
        break;
      }
      if (outcome.kind === "succeeded") counts.succeeded += 1;
      else if (outcome.kind === "failed") counts.failed += 1;
      else if (outcome.kind === "poll_error") counts.pollErrors += 1;
      else if (outcome.kind === "raced") counts.raced += 1;
      else counts.pending += 1;
    }
  } catch {
    counts.ok = false;
  } finally {
    clearTimeout(timer);
  }
  return counts;
}

export function reconciliationTelemetry(counts) {
  return {
    event: "video_reconciliation",
    version: 1,
    ok: counts.ok,
    checked: counts.checked,
    succeeded: counts.succeeded,
    failed: counts.failed,
    pending: counts.pending,
    pollErrors: counts.pollErrors,
    raced: counts.raced,
  };
}
