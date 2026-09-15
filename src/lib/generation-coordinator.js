import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { getDb } from "./db";
import { generations } from "./schema";
import { rowToItem } from "./store-db";

export const DEFAULT_POLL_DELAY_MS = 5_000;
export const MAX_COORDINATOR_BATCH = 25;

export function isCoordinatorEligible(item) {
  return (item?.status === "queued" && ["image", "video"].includes(item?.kind)) ||
    (item?.status === "running" && item?.kind === "video");
}

export function normalizeProviderTimestamp(value) {
  if (value == null) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? Math.round(value * 1000) : Math.round(value);
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function providerTimestamps(payload = {}) {
  const source = payload.data && typeof payload.data === "object" ? payload.data : payload;
  return {
    providerCreatedAt: normalizeProviderTimestamp(source.created_at ?? source.createdAt),
    providerUpdatedAt: normalizeProviderTimestamp(source.updated_at ?? source.updatedAt),
    providerStatus: source.status ?? source.state,
  };
}

export async function claimGeneration(id, owner, { now = Date.now(), ttlMs = 60_000, db: dbOverride } = {}) {
  if (!id || !owner) throw new Error("generation id and worker owner are required");
  const db = dbOverride ?? await getDb();
  const rows = await db.update(generations).set({
    workerLeaseId: owner,
    workerLeaseUntil: now + ttlMs,
  }).where(and(
    eq(generations.id, id),
    or(
      and(eq(generations.status, "queued"), inArray(generations.kind, ["image", "video"])),
      and(eq(generations.status, "running"), eq(generations.kind, "video")),
    ),
    or(isNull(generations.workerLeaseUntil), lte(generations.workerLeaseUntil, now), eq(generations.workerLeaseId, owner)),
  )).returning();
  return rows[0] ? rowToItem(rows[0]) : undefined;
}

export async function releaseGeneration(id, owner, { db: dbOverride } = {}) {
  const db = dbOverride ?? await getDb();
  const rows = await db.update(generations).set({
    workerLeaseId: null,
    workerLeaseUntil: null,
  }).where(and(eq(generations.id, id), eq(generations.workerLeaseId, owner))).returning();
  return rows[0] ? rowToItem(rows[0]) : undefined;
}

export async function selectDueGenerations({ now = Date.now(), limit = MAX_COORDINATOR_BATCH, db: dbOverride } = {}) {
  const db = dbOverride ?? await getDb();
  const safeLimit = Math.max(1, Math.min(MAX_COORDINATOR_BATCH, Number(limit) || MAX_COORDINATOR_BATCH));
  const rows = await db.select().from(generations).where(and(
    or(
      and(eq(generations.status, "queued"), inArray(generations.kind, ["image", "video"])),
      and(eq(generations.status, "running"), eq(generations.kind, "video")),
    ),
    or(isNull(generations.nextPollAt), lte(generations.nextPollAt, now)),
    or(isNull(generations.workerLeaseUntil), lte(generations.workerLeaseUntil, now)),
  )).orderBy(generations.createdAt).limit(safeLimit);
  return rows.map(rowToItem);
}

export async function scheduleGeneration(item, {
  now = Date.now(), delayMs = DEFAULT_POLL_DELAY_MS, provider = {}, db: dbOverride,
} = {}) {
  const db = dbOverride ?? await getDb();
  const rows = await db.update(generations).set({
    lastPollAt: now,
    nextPollAt: now + Math.max(0, delayMs),
    pollAttempts: sql`${generations.pollAttempts} + 1`,
    ...provider,
  }).where(and(
    eq(generations.id, item.id),
    eq(generations.status, item.status),
    eq(generations.updatedAt, item.updatedAt),
  )).returning();
  return rows[0] ? rowToItem(rows[0]) : undefined;
}
