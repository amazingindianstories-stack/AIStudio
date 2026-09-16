import { randomUUID } from "node:crypto";
import { advanceVideoStatus } from "../lib/video-status-advancement.js";
import { claimGeneration, releaseGeneration, selectDueGenerations } from "../lib/generation-coordinator.js";
import { getItem } from "../lib/store-db.js";
import { publishGenerationUpdate } from "../lib/generation-realtime.js";

export async function runCoordinatorOnce({
  owner = `worker:${randomUUID()}`,
  now = Date.now(),
  select = selectDueGenerations,
  claim = claimGeneration,
  release = releaseGeneration,
  advance = advanceVideoStatus,
  fetchImpl = fetch,
  baseUrl = process.env.GENERATION_WORKER_URL || process.env.NEXT_PUBLIC_APP_URL,
  logger = console,
} = {}) {
  const rows = await select({ now });
  const counts = { selected: rows.length, claimed: 0, advanced: 0, submitted: 0, errors: 0 };
  for (const row of rows) {
    const claimed = await claim(row.id, owner, { now });
    if (!claimed) continue;
    counts.claimed += 1;
    try {
      if (claimed.status === "queued") {
        if (!baseUrl) throw new Error("GENERATION_WORKER_URL or NEXT_PUBLIC_APP_URL is required");
        const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/api/queue/execute`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-generation-worker-secret": process.env.GENERATION_WORKER_SECRET || "" },
          body: JSON.stringify({ id: claimed.id }),
        });
        if (!response.ok) throw new Error(`queue submission failed (${response.status})`);
        counts.submitted += 1;
      } else {
        await advance(claimed, { source: "worker" });
        counts.advanced += 1;
      }
      const current = await getItem(claimed.id).catch(() => undefined);
      if (current) await publishGenerationUpdate(current).catch((error) => logger.warn?.(error?.message));
    } catch (error) {
      counts.errors += 1;
      logger.error?.(JSON.stringify({ event: "generation_worker_error", generationId: row.id, message: error?.message }));
    } finally {
      await release(row.id, owner).catch(() => {});
    }
  }
  return counts;
}

export async function runGenerationWorker({ intervalMs = 2_000, signal } = {}) {
  while (!signal?.aborted) {
    await runCoordinatorOnce();
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

if (process.argv[1]?.endsWith("generation-worker.js")) {
  runGenerationWorker().catch((error) => { console.error(error); process.exitCode = 1; });
}
