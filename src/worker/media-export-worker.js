import { randomUUID } from "node:crypto";
import { claimMediaExport, completeMediaExport, failMediaExport, heartbeatMediaExport } from "../lib/media-exports-db.js";
import { createResumableWriter } from "../lib/gcs-resumable-writer.js";
import { extensionFromContentType, writeZip64 } from "../lib/zip64-stream.js";

async function control(baseUrl, secret, payload, fetchImpl) {
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/api/worker/exports/access`, { method: "POST", headers: { "Content-Type": "application/json", "x-generation-worker-secret": secret }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`export access failed (${response.status})`);
  return response.json();
}

export async function runExportOnce({
  owner = `export-worker:${randomUUID()}`, now = Date.now(), claim = claimMediaExport,
  heartbeat = heartbeatMediaExport, complete = completeMediaExport, fail = failMediaExport,
  fetchImpl = fetch, baseUrl = process.env.GENERATION_WORKER_URL || process.env.NEXT_PUBLIC_APP_URL,
  secret = process.env.GENERATION_WORKER_SECRET, logger = console,
} = {}) {
  const job = await claim(owner, now);
  if (!job) return { claimed: 0 };
  try {
    if (!baseUrl || !secret) throw new Error("export worker configuration is incomplete");
    const upload = await control(baseUrl, secret, { action: "upload", exportId: job.id, owner }, fetchImpl);
    const writer = createResumableWriter(upload.url, { fetchImpl });
    const warnings = []; let processed = 0; let lastHeartbeat = Date.now();
    async function* sources() {
      for (const item of job.items) {
        let access; let head;
        try {
          access = await control(baseUrl, secret, { action: "source", exportId: job.id, generationId: item.generationId, owner }, fetchImpl);
          head = await fetchImpl(access.url, { method: "HEAD" });
          if (!head.ok) throw new Error(`source unavailable (${head.status})`);
        } catch (error) {
          warnings.push({ id: item.generationId, reason: String(error?.message || error).slice(0, 160) });
          processed += 1; await heartbeat(job.id, owner, { processedItems: processed, skippedItems: warnings.length, warnings }); continue;
        }
        const size = Number(head.headers.get("content-length"));
        if (!Number.isSafeInteger(size) || size < 0) throw new Error(`source length unavailable for ${item.generationId}`);
        const ext = extensionFromContentType(head.headers.get("content-type"), item.sourceKey);
        const response = await fetchImpl(access.url);
        if (!response.ok || !response.body) throw new Error(`source read failed (${response.status})`);
        yield { name: `${item.filename}.${ext}`, size, stream: response.body };
      }
    }
    const result = await writeZip64(sources(), async (bytes) => {
      await writer.write(bytes);
      if (Date.now() - lastHeartbeat > 30_000) { await heartbeat(job.id, owner, { processedItems: processed, skippedItems: warnings.length, warnings }); lastHeartbeat = Date.now(); }
    }, { onEntry: async () => { processed += 1; await heartbeat(job.id, owner, { processedItems: processed, skippedItems: warnings.length, warnings }); } });
    const outputBytes = await writer.finish();
    await complete(job.id, owner, { outputKey: upload.key, outputBytes, skippedItems: warnings.length, warnings });
    return { claimed: 1, completed: 1, entries: result.entries, skipped: warnings.length };
  } catch (error) {
    await fail(job.id, owner, error?.message || error).catch(() => {});
    logger.error?.({ event: "media_export_worker_error", exportId: job.id, message: String(error?.message || error).slice(0, 300) });
    return { claimed: 1, completed: 0, errors: 1 };
  }
}

export async function runMediaExportWorker({ intervalMs = 2_000, signal, runOnce = runExportOnce, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), logger = console } = {}) {
  while (!signal?.aborted) {
    try { await runOnce(); } catch (error) { logger.error?.({ event: "media_export_loop_error", message: String(error?.message || error).slice(0, 300) }); }
    if (!signal?.aborted) await wait(intervalMs);
  }
}
