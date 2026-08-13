import { cookies } from "next/headers";
import { timingSafeEqual, createHmac } from "crypto";
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { users } from "./schema";

export { hashPassword, verifyPassword } from "./password";

export const SESSION_COOKIE = "veevee_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const SESSION_TTL_MS = 1000 * SESSION_MAX_AGE_SECONDS;
// Rolling renewal: getSession() silently reissues the cookie once a session
// is this old, resetting the 30-day clock. Without this, the 30 days count
// from LOGIN, not last use — a daily user still gets logged out a month
// later. Throttled (not renewed on every request) so an active user gets at
// most one re-sign per day, not one per request.
const SESSION_RENEW_AFTER_MS = 1000 * 60 * 60 * 24; // 1 day

// ---- stateless signed session cookie (HMAC) ----

function secret() {
  const value = process.env.AUTH_SECRET;
  if (value) return value;
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET is required in production.");
  }
  return "dev-insecure-secret-change-me";
}

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

/** Single source of truth for the cookie's flags — login, password-change
 *  re-issue, and getSession()'s rolling renewal all use this, so a maxAge or
 *  flag fix made once can't drift out of sync between the three. */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" ,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

/** Pure so it's testable without a live cookie store — renew once a session
 *  is more than SESSION_RENEW_AFTER_MS old (i.e. less than
 *  SESSION_TTL_MS - SESSION_RENEW_AFTER_MS remains). */
export function shouldRenewSession(exp, now = Date.now()) {
  return exp - now < SESSION_TTL_MS - SESSION_RENEW_AFTER_MS;
}

export function signSession(userId, authVersion) {
  const payload = b64url(
    JSON.stringify({ uid: userId, ver: authVersion, exp: Date.now() + SESSION_TTL_MS })
  );
  const sig = createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

/** Verify the signed cookie without consulting the database.
 *
 * Most application routes must use `getSession()` so disabled users and bumped
 * auth versions take effect immediately. High-fanout, read-only media requests
 * may use this verifier to avoid opening one database connection per image.
 */
export function verifySessionToken(
  token
) {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", secret())
    .update(payload)
    .digest("base64url");
  // constant-time compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { uid, ver: rawVersion, exp } = JSON.parse(
      Buffer.from(payload, "base64url").toString()
    );
    // Cookies issued before session versioning had no `ver`; migration adds
    // auth_version=0 so those sessions remain valid through the rollout.
    const ver = rawVersion ?? 0;
    if (
      typeof uid !== "string" ||
      !uid ||
      !Number.isInteger(ver) ||
      ver < 0 ||
      typeof exp !== "number" ||
      exp < Date.now()
    ) {
      return null;
    }
    return { userId: uid, authVersion: ver, exp };
  } catch {
    return null;
  }
}

// ---- session lookup (server) ----

/** Current logged-in user, or null. Reads + verifies the session cookie. */
export async function getSession() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = verifySessionToken(token);
  if (!session) return null;
  const db = await getDb();
  const row = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      color: users.color,
      avatarUrl: users.avatarUrl,
      isActive: users.isActive,
      authVersion: users.authVersion,
    })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);
  const u = row[0];
  if (!u || !u.isActive || u.authVersion !== session.authVersion) return null;

  if (shouldRenewSession(session.exp)) {
    try {
      store.set(SESSION_COOKIE, signSession(u.id, u.authVersion), sessionCookieOptions());
    } catch {
      // cookies().set() only works inside a Route Handler/Server Action's
      // mutable cookie scope — if getSession() is ever called somewhere else
      // (a Server Component render), this throws. Renewal is a courtesy;
      // skip it rather than fail the whole session lookup over it.
    }
  }

  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    color: u.color,
    avatarUrl: u.avatarUrl,
    authVersion: u.authVersion,
  };
}

export async function requireUser() {
  const u = await getSession();
  if (!u) throw new Error("UNAUTHENTICATED");
  return u;
}

export async function requireAdmin() {
  const u = await requireUser();
  if (u.role !== "admin") throw new Error("FORBIDDEN");
  return u;
}

/** Every project here is a shared workspace — any signed-in teammate can see,
 *  favorite, refile, and edit anyone else's items, and that's intentional,
 *  not a gap. This helper draws the one line that does matter: it gates the
 *  small set of actions that either destroy data outright (permanently
 *  deleting a generation, deleting/renaming a shared board) or spend/consume
 *  another person's in-flight job (triggering someone else's queued
 *  execution). Those require the acting user to be the owner or an admin.
 *  A null/undefined ownerId (rows created before ownership was tracked, or a
 *  board with no recorded creator) can't prove anyone's ownership, so it
 *  falls to admin-only rather than defaulting open. */
export function canManage(user, ownerId) {
  if (!user) return false;
  if (user.role === "admin") return true;
  return !!ownerId && user.id === ownerId;
}
