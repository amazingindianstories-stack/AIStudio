import { and, eq } from "drizzle-orm";
import { getDb } from "./db";
import { settings, userLimits } from "./schema";
import { LIMIT_DEFINITIONS, limitDefinition, parseLimitValue } from "./limits";

/** DB-backed limits access (kept separate so limits.ts stays client-safe,
 *  mirroring pricing.ts/pricing-db.ts and the settings table this reuses). */

function requireDefinition(key) {
  const def = limitDefinition(key);
  if (!def) throw new Error(`Unknown limit key: ${key}`);
  return def;
}

/** The admin-set global value for one limit, or the registry's hardcoded
 *  default if no admin has touched it yet. */
export async function readGlobalLimit(key) {
  const def = requireDefinition(key);
  const db = await getDb();
  const [row] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  return parseLimitValue(row?.value, def);
}

export async function updateGlobalLimit(key, value) {
  requireDefinition(key);
  const db = await getDb();
  await db
    .insert(settings)
    .values({ key, value: String(value), updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: String(value), updatedAt: Date.now() },
    });
}

/** Every registered limit's current global value, for the Limits tab —
 *  always one entry per LIMIT_DEFINITIONS regardless of which ones an admin
 *  has actually set, so the tab has something to render for a brand-new
 *  limit type with no settings row yet. */
export async function readAllGlobalLimits() {
  const db = await getDb();
  const rows = await db.select().from(settings);
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const out = {};
  for (const def of LIMIT_DEFINITIONS) {
    out[def.key] = parseLimitValue(byKey.get(def.key), def);
  }
  return out;
}

/** One user's personal overrides, keyed by limit key — only the keys they
 *  actually have a row for (i.e. have been given a personal override on),
 *  not every registered limit. Absence of a key means "uses the global
 *  default", which the caller (readEffectiveLimit) is what interprets that
 *  absence, not this function returning a filled-in default here. */
export async function readUserLimits(userId) {
  const db = await getDb();
  const rows = await db.select().from(userLimits).where(eq(userLimits.userId, userId));
  const out = {};
  for (const row of rows) {
    const def = limitDefinition(row.key);
    if (def) out[row.key] = parseLimitValue(row.value, def);
  }
  return out;
}

/** Every user's overrides in one query, keyed by userId then limit key — for
 *  the Users tab, which needs this for every row and must not run one query
 *  per user to get it. */
export async function readAllUserLimits() {
  const db = await getDb();
  const rows = await db.select().from(userLimits);
  const out = {};
  for (const row of rows) {
    const def = limitDefinition(row.key);
    if (!def) continue;
    (out[row.userId] ??= {})[row.key] = parseLimitValue(row.value, def);
  }
  return out;
}

/** `value: number` sets/replaces a user's override for `key`; `null` clears
 *  it, reverting them to the global default. */
export async function updateUserLimit(
  userId,
  key,
  value
) {
  requireDefinition(key);
  const db = await getDb();
  if (value === null) {
    await db
      .delete(userLimits)
      .where(and(eq(userLimits.userId, userId), eq(userLimits.key, key)));
    return;
  }
  await db
    .insert(userLimits)
    .values({ userId, key, value: String(value), updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: [userLimits.userId, userLimits.key],
      set: { value: String(value), updatedAt: Date.now() },
    });
}

/** The limit that actually applies to one request: the signed-in user's
 *  personal override if an admin set one, else the global default. `userId`
 *  is optional because generate/video allows anonymous requests — with no
 *  user row to look an override up on, it always gets the global default. */
export async function readEffectiveLimit(
  key,
  userId
) {
  const def = requireDefinition(key);
  if (userId) {
    const db = await getDb();
    const [row] = await db
      .select()
      .from(userLimits)
      .where(and(eq(userLimits.userId, userId), eq(userLimits.key, key)))
      .limit(1);
    if (row) return parseLimitValue(row.value, def);
  }
  return readGlobalLimit(key);
}

/** Every registered limit's effective value for one user, for /api/settings
 *  — a single query pass for the user's overrides, filling in the global
 *  default for anything not overridden. */
export async function readAllEffectiveLimits(
  userId
) {
  const [globalLimits, userOverrides] = await Promise.all([
    readAllGlobalLimits(),
    userId ? readUserLimits(userId) : Promise.resolve({} ),
  ]);
  const out = {};
  for (const def of LIMIT_DEFINITIONS) {
    out[def.key] = userOverrides[def.key] ?? globalLimits[def.key];
  }
  return out;
}
