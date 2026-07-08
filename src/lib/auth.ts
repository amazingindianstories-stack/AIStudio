import { cookies } from "next/headers";
import { timingSafeEqual, createHmac } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { users } from "./schema";

export { hashPassword, verifyPassword } from "./password";

export const SESSION_COOKIE = "lumina_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: string;
  color: string | null;
}

// ---- stateless signed session cookie (HMAC) ----

function secret(): string {
  return process.env.AUTH_SECRET || "dev-insecure-secret-change-me";
}

function b64url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

export function signSession(userId: string): string {
  const payload = b64url(JSON.stringify({ uid: userId, exp: Date.now() + SESSION_TTL_MS }));
  const sig = createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifySessionToken(token: string): string | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", secret())
    .update(payload)
    .digest("base64url");
  // constant-time compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { uid, exp } = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (!uid || typeof exp !== "number" || exp < Date.now()) return null;
    return uid as string;
  } catch {
    return null;
  }
}

// ---- session lookup (server) ----

/** Current logged-in user, or null. Reads + verifies the session cookie. */
export async function getSession(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const uid = verifySessionToken(token);
  if (!uid) return null;
  const row = await db.select().from(users).where(eq(users.id, uid)).limit(1);
  const u = row[0];
  if (!u || !u.isActive) return null;
  return { id: u.id, email: u.email, name: u.name, role: u.role, color: u.color };
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
