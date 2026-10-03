import crypto from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { getDb } from "./db.js";
import { organizationIdempotencyKeys } from "./schema.js";
import { OrganizationError } from "./folder-errors.js";

export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Recursively canonicalizes a JS object/array so JSON.stringify produces
 * an identical byte-for-byte representation regardless of property ordering.
 */
export function canonicalizeValue(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === "bigint") return val.toString();
  if (typeof val !== "object") return val;
  if (Array.isArray(val)) {
    return val.map(canonicalizeValue);
  }
  const keys = Object.keys(val).sort();
  const sortedObj = {};
  for (const k of keys) {
    if (val[k] !== undefined) {
      sortedObj[k] = canonicalizeValue(val[k]);
    }
  }
  return sortedObj;
}

/**
 * Computes a deterministic SHA-256 fingerprint from a canonicalized request payload.
 */
export function computeFingerprint(payload) {
  const canonical = canonicalizeValue(payload ?? {});
  const str = JSON.stringify(canonical);
  return crypto.createHash("sha256").update(str).digest("hex");
}

/**
 * Deletes all expired idempotency keys from the database.
 */
export async function cleanExpiredIdempotencyKeys(txOrDb, now = Date.now()) {
  const runner = txOrDb || (await getDb());
  await runner.execute(sql`
    DELETE FROM organization_idempotency_keys
    WHERE expires_at > 0 AND expires_at <= ${now}
  `);
}

/**
 * Shared concurrency-safe idempotency coordinator.
 *
 * 1. Takes a transaction-level advisory lock on hashtext('idempotency:' || key)
 *    so simultaneous requests for the exact same key serialize immediately.
 * 2. Checks existing records for key collisions.
 * 3. Enforces strict invariants:
 *    - Rejects reuse with a different actor.
 *    - Rejects reuse with a different operation.
 *    - Rejects reuse with a different payload (fingerprint mismatch).
 * 4. If key is completed and valid, returns cached result immediately without mutation.
 * 5. If key is fresh (or expired), executes mutationFn, records result transactionally, and returns.
 */
export async function executeWithIdempotency(
  {
    tx = null,
    db = null,
    key = null,
    actorId = null,
    operation,
    payload = {},
    ttlMs = DEFAULT_IDEMPOTENCY_TTL_MS,
  },
  mutationFn
) {
  if (!key) {
    if (tx) return await mutationFn(tx);
    const database = db || (await getDb());
    return await database.transaction(async (innerTx) => {
      return await mutationFn(innerTx);
    });
  }

  const normalizedKey = String(key).trim();
  if (!normalizedKey) {
    if (tx) return await mutationFn(tx);
    const database = db || (await getDb());
    return await database.transaction(async (innerTx) => {
      return await mutationFn(innerTx);
    });
  }

  const runWithTx = async (activeTx) => {
    // 1. Transaction-level advisory lock serializes simultaneous requests for the same key
    await activeTx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${'idempotency:' + normalizedKey}))`
    );

    const fingerprint = computeFingerprint(payload);
    const now = Date.now();

    // 2. Check existing record
    const [existing] = await activeTx
      .select()
      .from(organizationIdempotencyKeys)
      .where(eq(organizationIdempotencyKeys.key, normalizedKey))
      .limit(1);

    if (existing) {
      const isExpired = Number(existing.expiresAt) > 0 && Number(existing.expiresAt) <= now;
      if (!isExpired) {
        // Validate actor
        const actorStr = actorId != null ? String(actorId) : null;
        const existingActorStr = existing.actorId != null ? String(existing.actorId) : null;
        if (existingActorStr !== actorStr) {
          throw new OrganizationError(
            "IDEMPOTENCY_ACTOR_MISMATCH",
            "Idempotency key reuse across different actors.",
            409
          );
        }

        // Validate operation
        if (existing.operation !== operation) {
          throw new OrganizationError(
            "IDEMPOTENCY_OPERATION_MISMATCH",
            `Idempotency key reuse across different operations: expected "${existing.operation}", got "${operation}".`,
            409
          );
        }

        // Validate fingerprint (payload)
        if (existing.fingerprint !== fingerprint) {
          throw new OrganizationError(
            "IDEMPOTENCY_PAYLOAD_MISMATCH",
            "Idempotency key reuse with different payload.",
            409
          );
        }

        // If completed, return cached result immediately
        if (existing.status === "completed") {
          return existing.result;
        }
      }
    }

    // 3. Key is fresh or expired: execute mutation
    const result = await mutationFn(activeTx);

    // 4. Save result transactionally
    const expiresAt = now + ttlMs;
    await activeTx
      .insert(organizationIdempotencyKeys)
      .values({
        key: normalizedKey,
        actorId: actorId != null ? String(actorId) : null,
        operation,
        fingerprint,
        status: "completed",
        result,
        createdAt: now,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: organizationIdempotencyKeys.key,
        set: {
          actorId: actorId != null ? String(actorId) : null,
          operation,
          fingerprint,
          status: "completed",
          result,
          createdAt: now,
          expiresAt,
        },
      });

    return result;
  };

  if (tx) {
    return await runWithTx(tx);
  }
  const database = db || (await getDb());
  return await database.transaction(async (innerTx) => {
    return await runWithTx(innerTx);
  });
}
