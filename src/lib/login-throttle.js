import { and, eq, gt, lt } from "drizzle-orm";
import { getDb } from "./db";
import { loginAttempts } from "./schema";

/**
 * Failed-login throttle. Server-only (called from /api/auth/login), so unlike
 * settings.ts/limits.ts there is no client-safe/DB split to maintain here —
 * pure decision logic and the DB access sit in the same file.
 *
 * Same shape as spend-window.ts's admission control: a pure function decides
 * "may this proceed", a DB-touching wrapper supplies the count it needs. Kept
 * that way so the decision itself is unit-testable without a live database.
 */

/** Rolling window a failure counts against. */
export const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

const DEFAULT_MAX_LOGIN_ATTEMPTS = 5;

function positiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Failures allowed per window before further attempts are throttled.
 *  Env-tunable so it can be relaxed/disabled without a deploy — same pattern
 *  as spend-window.ts's spendLimitCents. 0 disables the gate entirely. */
export function maxLoginAttempts(env = process.env) {
  const raw = env.LOGIN_MAX_ATTEMPTS;
  if (raw !== undefined && Number(raw) === 0) return 0; // explicit opt-out
  return positiveInt(raw, DEFAULT_MAX_LOGIN_ATTEMPTS);
}

/** Decide whether another login attempt for this identifier may proceed. */
export function admitsLoginAttempt(i) {
  if (i.maxAttempts <= 0) return true; // gate disabled
  return i.recentFailureCount < i.maxAttempts;
}

/** How long until the throttle clears, for the client's error message.
 *  Failures leave the window exactly LOGIN_ATTEMPT_WINDOW_MS after the
 *  oldest one in it, so that row's age is the soonest moment an attempt is
 *  admitted again. */
export function loginRetryAfterMs(oldestFailureAt, now) {
  if (oldestFailureAt === null) return 0;
  return Math.max(oldestFailureAt + LOGIN_ATTEMPT_WINDOW_MS - now, 0);
}

function normalizeIdentifier(email) {
  return String(email || "").toLowerCase().trim();
}

/**
 * Checks whether a login attempt for `email` is currently throttled.
 * Opportunistically deletes this identifier's expired attempt rows first —
 * cheap (one indexed delete) and keeps the table from growing unbounded
 * without a separate cleanup job.
 */
export async function checkLoginThrottle(email, env = process.env) {
  const maxAttempts = maxLoginAttempts(env);
  if (maxAttempts <= 0) return { allowed: true, retryAfterMs: 0 };

  const identifier = normalizeIdentifier(email);
  const now = Date.now();
  const windowStart = now - LOGIN_ATTEMPT_WINDOW_MS;
  const db = await getDb();

  await db
    .delete(loginAttempts)
    .where(and(eq(loginAttempts.identifier, identifier), lt(loginAttempts.createdAt, windowStart)));

  const rows = await db
    .select({ createdAt: loginAttempts.createdAt })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.identifier, identifier), gt(loginAttempts.createdAt, windowStart)));

  const allowed = admitsLoginAttempt({ recentFailureCount: rows.length, maxAttempts });
  const oldestFailureAt = rows.length
    ? rows.reduce((min, r) => Math.min(min, r.createdAt), Infinity)
    : null;
  return {
    allowed,
    retryAfterMs: allowed ? 0 : loginRetryAfterMs(oldestFailureAt, now),
  };
}

/** Records one failed attempt. Called only after credentials are confirmed
 *  invalid — a throttled request never reaches this (see checkLoginThrottle's
 *  caller), so this never runs on an already-blocked identifier. */
export async function recordLoginFailure(email) {
  const db = await getDb();
  await db.insert(loginAttempts).values({
    identifier: normalizeIdentifier(email),
    createdAt: Date.now(),
  });
}
