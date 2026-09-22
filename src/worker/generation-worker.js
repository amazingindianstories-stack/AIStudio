import { randomUUID } from "node:crypto";
import { advanceVideoStatus } from "../lib/video-status-advancement.js";
import { claimGeneration, releaseGeneration, scheduleGeneration, selectDueGenerations } from "../lib/generation-coordinator.js";
import { getItem } from "../lib/store-db.js";
import { publishGenerationUpdate } from "../lib/generation-realtime.js";

const MIN_DELAY_MS = 5_000;
const MAX_DELAY_MS = 60_000;

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
  for (const row of rows) {
    let claimed;
    try {
      claimed = await claim(row.id, owner, { now });
      if (!claimed) continue;
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
      const current = await getItem(claimed.id).catch(() => undefined);
      if (current) await publishGenerationUpdate(current).catch((error) => logger.warn?.(error?.message));
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
  return counts;
}

export async function runGenerationWorker({ intervalMs = 2_000, signal, runOnce = runCoordinatorOnce, logger = console } = {}) {
  while (!signal?.aborted) {
    try {
      const counts = await runOnce();
      const delay = counts.errors ? boundedRetryDelay(intervalMs * 4) : intervalMs;
      await new Promise((resolve) => setTimeout(resolve, delay));
    } catch (error) {
      logger.error?.({ event: "generation_worker_loop_error", ...safeWorkerError(error) });
      await new Promise((resolve) => setTimeout(resolve, boundedRetryDelay(intervalMs * 4)));
    }
  }
}

if (process.argv[1]?.endsWith("generation-worker.js")) {
  runGenerationWorker().catch((error) => { console.error(safeWorkerError(error)); process.exitCode = 1; });
}
