import { cookies } from "next/headers";
import { timingSafeEqual, createHmac } from "crypto";
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { users } from "./schema";

export { hashPassword, verifyPassword } from "./password";

export const SESSION_COOKIE = "lumina_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const SESSION_TTL_MS = 1000 * SESSION_MAX_AGE_SECONDS;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: string;
  color: string | null;
  avatarUrl: string | null;
}

export interface AuthenticatedSession extends SessionUser {
  authVersion: number;
}

// ---- stateless signed session cookie (HMAC) ----

function secret(): string {
  const value = process.env.AUTH_SECRET;
  if (value) return value;
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET is required in production.");
  }
  return "dev-insecure-secret-change-me";
}

function b64url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

export function signSession(userId: string, authVersion: number): string {
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
  token: string
): { userId: string; authVersion: number } | null {
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
    return { userId: uid, authVersion: ver };
  } catch {
    return null;
  }
}

// ---- session lookup (server) ----

/** Current logged-in user, or null. Reads + verifies the session cookie. */
export async function getSession(): Promise<AuthenticatedSession | null> {
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

export async function requireUser(): Promise<SessionUser> {
  const u = await getSession();
  if (!u) throw new Error("UNAUTHENTICATED");
  return u;
}

export async function requireAdmin(): Promise<SessionUser> {
  const u = await requireUser();
  if (u.role !== "admin") throw new Error("FORBIDDEN");
  return u;
}
