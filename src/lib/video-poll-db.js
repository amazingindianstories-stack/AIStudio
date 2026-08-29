import { and, asc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { getDb } from "./db";
import { generations } from "./schema";
import { rowToItem } from "./store-db";

const ACTIVE = ["queued", "running"];

function expectedWhere(expected) {
  return and(
    eq(generations.id, expected.id),
    eq(generations.kind, "video"),
    eq(generations.status, expected.status),
    eq(generations.updatedAt, expected.updatedAt),
    eq(generations.taskId, expected.taskId)
  );
}

/** Atomically record a transient provider-read failure without changing staleness. */
export async function recordVideoPollError(expected, at = Date.now(), dbOverride) {
  const db = dbOverride ?? await getDb();
  const rows = await db.update(generations).set({
    pollErrorCount: sql`${generations.pollErrorCount} + 1`,
    lastPollErrorAt: at,
  }).where(expectedWhere(expected)).returning({
    pollErrorCount: generations.pollErrorCount,
    lastPollErrorAt: generations.lastPollErrorAt,
  });
  return rows[0];
}

/** A successful provider response resets health but does not refresh updatedAt. */
export async function clearVideoPollErrors(expected, dbOverride) {
  const db = dbOverride ?? await getDb();
  const rows = await db.update(generations).set({
    pollErrorCount: 0,
    lastPollErrorAt: null,
  }).where(expectedWhere(expected)).returning();
  return rows[0] ? rowToItem(rows[0]) : undefined;
}

/** Persist a conclusive outcome only if the row is still the version polled. */
export async function compareAndSetVideoOutcome(expected, updates, dbOverride) {
  const db = dbOverride ?? await getDb();
  const rows = await db.update(generations).set({
    ...updates,
    pollErrorCount: 0,
    lastPollErrorAt: null,
  }).where(expectedWhere(expected)).returning();
  return rows[0] ? rowToItem(rows[0]) : undefined;
}

/** Oldest unchanged rows first; task-less rows can never be provider-polled. */
export async function selectStaleVideoPollCandidates({
  before,
  limit = 5,
  db: dbOverride,
} = {}) {
  const db = dbOverride ?? await getDb();
  const boundedLimit = Math.max(0, Math.min(5, Number(limit) || 0));
  if (!boundedLimit) return [];
  const rows = await db.select().from(generations).where(and(
    eq(generations.kind, "video"),
    inArray(generations.status, ACTIVE),
    isNotNull(generations.taskId),
    lte(generations.updatedAt, before)
  )).orderBy(
    asc(generations.updatedAt),
    asc(generations.createdAt),
    asc(generations.id)
  ).limit(boundedLimit);
  return rows.map(rowToItem);
}
