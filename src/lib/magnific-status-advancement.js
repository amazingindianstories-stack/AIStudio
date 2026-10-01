import sharp from "sharp";
import { and, eq } from "drizzle-orm";
import { getDb } from "./db";
import { generations } from "./schema";
import { rowToItem } from "./store-db";
import { getMagnificUpscaleStatus, isMagnificModel } from "./providers/magnific";
import { saveBufferWithMetadata } from "./generated-media-persistence";
import { publishGenerationUpdate } from "./generation-realtime";
import { scheduleGeneration } from "./generation-coordinator";

export const MAX_MAGNIFIC_OUTPUT_BYTES = 80 * 1024 * 1024;
const privateHost = /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i;

export function assertMagnificItem(item) {
  if (!item || !isMagnificModel(item.model) || item.kind !== "image" || !item.taskId) {
    throw new TypeError("Generation is not a Magnific job.");
  }
}

async function conditionalUpdate(item, values) {
  const db = await getDb();
  const rows = await db.update(generations).set(values).where(and(
    eq(generations.id, item.id), eq(generations.status, item.status), eq(generations.updatedAt, item.updatedAt)
  )).returning();
  return rows[0] ? rowToItem(rows[0]) : undefined;
}

async function downloadOutput(url, fetchImpl, signal) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error("Magnific returned an invalid output URL."); }
  if (parsed.protocol !== "https:" || privateHost.test(parsed.hostname)) throw new Error("Magnific returned an unsafe output URL.");
  const response = await fetchImpl(url, { signal: signal || AbortSignal.timeout(30_000), redirect: "error" });
  if (!response.ok) throw new Error(`Failed to download upscaled image from provider (${response.status}).`);
  const length = Number(response.headers.get("content-length") || 0);
  if (length > MAX_MAGNIFIC_OUTPUT_BYTES) throw new Error("Magnific output exceeds the 80 MB limit.");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > MAX_MAGNIFIC_OUTPUT_BYTES) throw new Error("Magnific output is empty or too large.");
  const meta = await sharp(buffer, { failOn: "error", limitInputPixels: 160_000_000 }).metadata();
  const extensions = { jpeg: "jpg", png: "png", webp: "webp" };
  const ext = extensions[meta.format];
  if (!ext) throw new Error("Magnific output is not a supported image.");
  return { buffer, ext };
}

export async function advanceMagnificStatus(item, {
  signal, fetchImpl = fetch, getStatus = getMagnificUpscaleStatus,
  save = saveBufferWithMetadata, publish = publishGenerationUpdate,
  schedule = scheduleGeneration, now = () => Date.now(), update = conditionalUpdate,
} = {}) {
  assertMagnificItem(item);
  if (["succeeded", "failed"].includes(item.status)) return { kind: item.status, item };
  const outcome = await getStatus({ model: item.model, taskId: item.taskId, signal, fetchImpl });
  if (outcome.status === "running") {
    const pending = await schedule(item, { now: now(), delayMs: 5_000, provider: { providerStatus: "IN_PROGRESS" } });
    return pending ? { kind: "pending", item: pending } : { kind: "raced" };
  }
  const timestamp = now();
  let values;
  if (outcome.status === "failed") {
    values = { status: "failed", error: outcome.error || "Magnific upscale task failed.", providerStatus: "FAILED", completedAt: timestamp, updatedAt: timestamp };
  } else {
    const { buffer, ext } = await downloadOutput(outcome.generatedUrl, fetchImpl, signal);
    const saved = await save(buffer, ext, item.id, { kind: "image", model: item.model, requestedAspectRatio: item.aspectRatio });
    values = { status: "succeeded", url: saved.url, aspectRatio: saved.aspectRatio || item.aspectRatio, providerStatus: "COMPLETED", completedAt: timestamp, updatedAt: timestamp };
    if (Number.isInteger(outcome.costCents)) Object.assign(values, { costCents: outcome.costCents, costBasis: "reconciled" });
  }
  const persisted = await update(item, values);
  if (!persisted) return { kind: "raced" };
  await publish(persisted).catch(() => {});
  return { kind: persisted.status, item: persisted };
}
