import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { getDb } from "./db";
import { generations } from "./schema";
import { rowToItem } from "./store-db";

export const DEFAULT_POLL_DELAY_MS = 5_000;
export const MAX_COORDINATOR_BATCH = 25;

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

export function generationEvent(item, version = 0) {
  return {
    type: "generation.updated",
    generationId: item.id,
    status: item.status,
    updatedAt: item.updatedAt,
    version: Number.isInteger(version) && version > 0 ? version : item.updatedAt,
  };
}

/** Claim one row. The lease condition makes duplicate workers harmless and
 * lets another worker recover a crashed process after the lease expires. */
export async function claimGeneration(id, owner, {
  now = Date.now(), ttlMs = 60_000,
  db: dbOverride,
} = {}) {
  if (!id || !owner) throw new Error("generation id and worker owner are required");
  const db = dbOverride ?? await getDb();
  const rows = await db.update(generations).set({
    workerLeaseId: owner,
    workerLeaseUntil: now + ttlMs,
  }).where(and(
    eq(generations.id, id),
    inArray(generations.status, ["queued", "running"]),
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
    inArray(generations.status, ["queued", "running"]),
    or(isNull(generations.nextPollAt), lte(generations.nextPollAt, now)),
    or(isNull(generations.workerLeaseUntil), lte(generations.workerLeaseUntil, now)),
  )).orderBy(generations.createdAt).limit(safeLimit);
  return rows.map(rowToItem);
}

export async function scheduleGeneration(item, {
  now = Date.now(), delayMs = DEFAULT_POLL_DELAY_MS, provider = {}, db: dbOverride,
} = {}) {
  const db = dbOverride ?? await getDb();
  const values = {
    lastPollAt: now,
    nextPollAt: now + Math.max(0, delayMs),
    pollAttempts: sql`${generations.pollAttempts} + 1`,
    ...provider,
  };
  const rows = await db.update(generations).set(values).where(and(
    eq(generations.id, item.id),
    eq(generations.status, item.status),
    eq(generations.updatedAt, item.updatedAt),
  )).returning();
  return rows[0] ? rowToItem(rows[0]) : undefined;
}

