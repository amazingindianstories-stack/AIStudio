import { randomUUID } from "node:crypto";
import { advanceVideoStatus } from "../lib/video-status-advancement.js";
import { claimGeneration, releaseGeneration, scheduleGeneration, selectDueGenerations } from "../lib/generation-coordinator.js";
import { getItem } from "../lib/store-db.js";
import { publishGenerationUpdate } from "../lib/generation-realtime.js";

const MIN_DELAY_MS = 5_000;
const MAX_DELAY_MS = 60_000;
export const DISPATCH_CONCURRENCY = 16;

export function boundedRetryDelay(value, fallback = MIN_DELAY_MS) {
  return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, Number(value) || fallback));
}

export function safeWorkerError(error) {
  return { name: error?.name || "Error", message: String(error?.message || error || "unknown error").slice(0, 300) };
}

export async function runCoordinatorOnce({
  owner = `worker:${randomUUID()}`,
  now = Date.now(),
  select = selectDueGenerations,
  claim = claimGeneration,
  release = releaseGeneration,
  schedule = scheduleGeneration,
  advance = advanceVideoStatus,
  fetchImpl = fetch,
  loadItem = getItem,
  publish = publishGenerationUpdate,
  baseUrl = process.env.GENERATION_WORKER_URL || process.env.NEXT_PUBLIC_APP_URL,
  secret = process.env.GENERATION_WORKER_SECRET,
  logger = console,
} = {}) {
  let rows;
  try {
    rows = await select({ now });
  } catch (error) {
    logger.error?.({ event: "generation_worker_select_error", ...safeWorkerError(error) });
    return { selected: 0, claimed: 0, advanced: 0, submitted: 0, deferred: 0, errors: 1 };
  }
  const counts = { selected: rows.length, claimed: 0, advanced: 0, submitted: 0, deferred: 0, errors: 0 };
  async function dispatch(row) {
    let claimed;
    try {
      claimed = await claim(row.id, owner, { now });
      if (!claimed) return;
      counts.claimed += 1;
      if (claimed.status === "queued") {
        if (!baseUrl || !secret) throw new Error("generation worker configuration is incomplete");
        const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/api/queue/execute`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-generation-worker-secret": secret },
          body: JSON.stringify({ id: claimed.id }),
        });
        if (!response.ok) throw new Error(`queue submission failed (${response.status})`);
        const body = await response.json().catch(() => ({}));
        if (body.notAdmitted) {
          await schedule(claimed, { now, delayMs: boundedRetryDelay(body.retryAfterMs) });
          counts.deferred += 1;
        } else {
          counts.submitted += 1;
        }
      } else {
        const outcome = await advance(claimed, { source: "worker" });
        if (outcome.kind === "poll_error") {
          await schedule(claimed, { now, delayMs: boundedRetryDelay(outcome.retryAfterMs) }).catch(() => {});
        }
        counts.advanced += 1;
      }
      const current = await loadItem(claimed.id).catch(() => undefined);
      if (current) await publish(current).catch((error) => logger.warn?.(error?.message));
    } catch (error) {
      counts.errors += 1;
      if (claimed) {
        const attempts = Math.max(1, (claimed.pollAttempts ?? 0) + 1);
        await schedule(claimed, { now, delayMs: boundedRetryDelay(MIN_DELAY_MS * (2 ** Math.min(attempts, 4))) }).catch(() => {});
      }
      logger.error?.({ event: "generation_worker_error", generationId: row.id, ...safeWorkerError(error) });
    } finally {
      if (claimed) await release(row.id, owner).catch(() => {});
    }
  }
  // The database lease remains the duplicate-submission guard. This pool only
  // bounds how many independent claimed rows can be dispatched at once.
  let cursor = 0;
  async function worker() {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      await dispatch(row);
    }
  }
  await Promise.all(Array.from({ length: Math.min(DISPATCH_CONCURRENCY, rows.length) }, worker));
  return counts;
}

export async function runGenerationWorker({
  intervalMs = 2_000,
  signal,
  runOnce = runCoordinatorOnce,
  logger = console,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxConcurrentCycles = DISPATCH_CONCURRENCY,
} = {}) {
  const active = new Set();
  const cycleLimit = Math.max(1, Number(maxConcurrentCycles) || DISPATCH_CONCURRENCY);

  // An image execute request remains open for the whole provider render. Do
  // not let a job that arrived just after the current SELECT wait for that
  // render to finish before the queue is scanned again. Claims and lockJob's
  // transactional admission remain the duplicate/global-cap guards; this
  // only keeps the coordinator responsive while earlier cycles are in flight.
  while (!signal?.aborted) {
    if (active.size >= cycleLimit) await Promise.race(active);
    if (signal?.aborted) break;

    let cycle;
    cycle = Promise.resolve()
      .then(() => runOnce())
      .catch((error) => {
        logger.error?.({ event: "generation_worker_loop_error", ...safeWorkerError(error) });
      })
      .finally(() => active.delete(cycle));
    active.add(cycle);
    await wait(intervalMs);
  }

  await Promise.allSettled(active);
}

if (process.argv[1]?.endsWith("generation-worker.js")) {
  runGenerationWorker().catch((error) => { console.error(safeWorkerError(error)); process.exitCode = 1; });
}
