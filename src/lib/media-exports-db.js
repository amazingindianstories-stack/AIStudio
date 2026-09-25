import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { getDb } from "./db.js";
import { generations, mediaExportItems, mediaExports } from "./schema.js";
import { mediaKeyFromRef } from "./storage.js";

export const EXPORT_CHUNK_LIMIT = 500;
export const EXPORT_TTL_MS = 7 * 24 * 60 * 60_000;
export const EXPORT_LEASE_MS = 90_000;
export const EXPORT_MAX_ATTEMPTS = 3;

export async function createMediaExport(userId, now = Date.now()) {
  const db = await getDb();
  const id = randomUUID();
  await db.insert(mediaExports).values({ id, userId, status: "draft", createdAt: now, updatedAt: now });
  return { id, status: "draft" };
}

export async function getOwnedMediaExport(id, userId) {
  const db = await getDb();
  const [row] = await db.select().from(mediaExports)
    .where(and(eq(mediaExports.id, id), eq(mediaExports.userId, userId))).limit(1);
  return row;
}

export async function appendMediaExportItems(id, userId, rawIds, now = Date.now()) {
  const ids = [...new Set(rawIds.filter((value) => typeof value === "string" && value))];
  if (!ids.length || ids.length > EXPORT_CHUNK_LIMIT) throw new Error("INVALID_EXPORT_ITEMS");
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [job] = await tx.select().from(mediaExports)
      .where(and(eq(mediaExports.id, id), eq(mediaExports.userId, userId))).limit(1).for("update");
    if (!job) throw new Error("EXPORT_NOT_FOUND");
    if (job.status !== "draft") throw new Error("EXPORT_NOT_DRAFT");
    const rows = await tx.select({ id: generations.id, kind: generations.kind, url: generations.url })
      .from(generations).where(inArray(generations.id, ids));
    const byId = new Map(rows.map((row) => [row.id, row]));
    const existing = await tx.select({ generationId: mediaExportItems.generationId })
      .from(mediaExportItems).where(eq(mediaExportItems.exportId, id));
    const seen = new Set(existing.map((row) => row.generationId));
    let position = existing.length;
    const accepted = [];
    const rejected = [];
    for (const generationId of ids) {
      const row = byId.get(generationId);
      const sourceKey = row?.kind === "image" ? mediaKeyFromRef(row.url) : null;
      if (!row || !sourceKey) { rejected.push({ id: generationId, reason: !row ? "not_found" : "not_downloadable" }); continue; }
      if (seen.has(generationId)) continue;
      position += 1;
      accepted.push({ exportId: id, generationId, position, sourceKey, filename: `${String(position).padStart(6, "0")}-${generationId}` });
    }
    if (accepted.length) await tx.insert(mediaExportItems).values(accepted).onConflictDoNothing();
    const totalItems = existing.length + accepted.length;
    await tx.update(mediaExports).set({ totalItems, updatedAt: now }).where(eq(mediaExports.id, id));
    return { accepted: accepted.length, totalItems, rejected };
  });
}

export async function finalizeMediaExport(id, userId, now = Date.now()) {
  const db = await getDb();
  const rows = await db.update(mediaExports).set({ status: "queued", updatedAt: now, error: null, attemptCount: 0 })
    .where(and(eq(mediaExports.id, id), eq(mediaExports.userId, userId), or(eq(mediaExports.status, "draft"), eq(mediaExports.status, "failed")), sql`${mediaExports.totalItems} > 0`))
    .returning();
  if (!rows[0]) throw new Error("EXPORT_NOT_FINALIZABLE");
  return rows[0];
}

export async function claimMediaExport(owner, now = Date.now()) {
  const db = await getDb();
  return db.transaction(async (tx) => {
    // Opportunistic retention keeps half-built selections from accumulating.
    // Ready archives are removed by GCS lifecycle; their small status row is
    // retained so an expired link can return a precise response.
    await tx.delete(mediaExports).where(or(
      and(eq(mediaExports.status, "draft"), lt(mediaExports.updatedAt, now - 24 * 60 * 60_000)),
      and(eq(mediaExports.status, "failed"), lt(mediaExports.updatedAt, now - EXPORT_TTL_MS))
    ));
    // A process can die during its final allowed attempt, bypassing fail().
    // Turn that expired lease into the same terminal state a caught error uses.
    await tx.update(mediaExports).set({ status: "failed", error: "Export worker stopped before completing the archive.", leaseOwner: null, leaseUntil: null, updatedAt: now })
      .where(and(eq(mediaExports.status, "running"), lt(mediaExports.leaseUntil, now), sql`${mediaExports.attemptCount} >= ${EXPORT_MAX_ATTEMPTS}`));
    const candidates = await tx.select({ id: mediaExports.id }).from(mediaExports)
      .where(and(
        or(eq(mediaExports.status, "queued"), and(eq(mediaExports.status, "running"), lt(mediaExports.leaseUntil, now))),
        lt(mediaExports.attemptCount, EXPORT_MAX_ATTEMPTS)
      )).orderBy(asc(mediaExports.createdAt)).limit(1).for("update", { skipLocked: true });
    if (!candidates[0]) return null;
    const [job] = await tx.update(mediaExports).set({ status: "running", leaseOwner: owner, leaseUntil: now + EXPORT_LEASE_MS, attemptCount: sql`${mediaExports.attemptCount} + 1`, processedItems: 0, skippedItems: 0, warnings: [], error: null, updatedAt: now })
      .where(eq(mediaExports.id, candidates[0].id)).returning();
    const items = await tx.select().from(mediaExportItems).where(eq(mediaExportItems.exportId, job.id)).orderBy(asc(mediaExportItems.position));
    return { ...job, items };
  });
}

export async function heartbeatMediaExport(id, owner, progress, now = Date.now()) {
  const db = await getDb();
  const [row] = await db.update(mediaExports).set({ ...progress, leaseUntil: now + EXPORT_LEASE_MS, updatedAt: now })
    .where(and(eq(mediaExports.id, id), eq(mediaExports.status, "running"), eq(mediaExports.leaseOwner, owner))).returning();
  return row;
}

export async function completeMediaExport(id, owner, { outputKey, outputBytes, skippedItems, warnings }, now = Date.now()) {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const [row] = await tx.update(mediaExports).set({ status: "ready", outputKey, outputBytes, processedItems: sql`${mediaExports.totalItems}`, skippedItems, warnings, expiresAt: now + EXPORT_TTL_MS, leaseOwner: null, leaseUntil: null, updatedAt: now })
      .where(and(eq(mediaExports.id, id), eq(mediaExports.leaseOwner, owner))).returning();
    if (row) await tx.delete(mediaExportItems).where(eq(mediaExportItems.exportId, id));
    return row;
  });
}

export async function failMediaExport(id, owner, error, now = Date.now()) {
  const db = await getDb();
  const [current] = await db.select({ attemptCount: mediaExports.attemptCount }).from(mediaExports).where(eq(mediaExports.id, id)).limit(1);
  const terminal = (current?.attemptCount ?? EXPORT_MAX_ATTEMPTS) >= EXPORT_MAX_ATTEMPTS;
  await db.update(mediaExports).set({ status: terminal ? "failed" : "queued", error: String(error).slice(0, 500), leaseOwner: null, leaseUntil: null, updatedAt: now })
    .where(and(eq(mediaExports.id, id), eq(mediaExports.leaseOwner, owner)));
}
