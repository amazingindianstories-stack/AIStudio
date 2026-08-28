import { and, eq, lte, sql } from "drizzle-orm";
import { getDb } from "./db";
import { settings } from "./schema";

function rowsFrom(result) {
  return result?.rows ?? result ?? [];
}

/**
 * Claim a short cross-instance lease using the existing settings table.
 * `updated_at` stores the expiry for reserved lease keys; ordinary settings
 * keep their usual last-updated meaning. The single INSERT/UPSERT statement is
 * the mutual-exclusion boundary, so no read-then-write race is possible.
 */
export async function claimDistributedLease(
  key,
  owner,
  { now = Date.now(), ttlMs = 30_000, db } = {}
) {
  if (!key.startsWith("lease:")) throw new Error("Distributed lease keys must start with lease:");
  if (!owner) throw new Error("Distributed lease owner is required");
  const database = db ?? (await getDb());
  const expiresAt = now + ttlMs;
  const result = await database.execute(sql`
    insert into settings (key, value, updated_at)
    values (${key}, ${owner}, ${expiresAt})
    on conflict (key) do update
      set value = excluded.value,
          updated_at = excluded.updated_at
      where settings.updated_at <= ${now}
    returning key
  `);
  return rowsFrom(result).length === 1;
}

/** Release only the caller's lease; a stale owner cannot clear a successor. */
export async function releaseDistributedLease(key, owner, { db } = {}) {
  const database = db ?? (await getDb());
  const removed = await database
    .delete(settings)
    .where(and(eq(settings.key, key), eq(settings.value, owner)))
    .returning({ key: settings.key });
  return removed.length === 1;
}

export async function readDistributedLease(key, { db } = {}) {
  const database = db ?? (await getDb());
  const [row] = await database
    .select({ owner: settings.value, expiresAt: settings.updatedAt })
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);
  return row ?? null;
}

export async function deleteExpiredLease(key, now = Date.now(), { db } = {}) {
  const database = db ?? (await getDb());
  const removed = await database
    .delete(settings)
    .where(and(eq(settings.key, key), lte(settings.updatedAt, now)))
    .returning({ key: settings.key });
  return removed.length === 1;
}
