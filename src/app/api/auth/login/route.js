import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { users } from "@/lib/schema";
import {
  verifyPassword,
  signSession,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/lib/auth";
import { logActivity } from "@/lib/activity";
import { checkLoginThrottle, recordLoginFailure } from "@/lib/login-throttle";

export const runtime = "nodejs";

export async function POST(req) {
  const db = await getDb();
  const { email, password } = await req.json().catch(() => ({}));
  if (!email || !password) {
    return NextResponse.json(
      { error: "Email and password are required." },
      { status: 400 }
    );
  }

  // Checked BEFORE the DB lookup / scrypt verification below — a blocked
  // identifier gets the 429 without ever touching the password hash.
  const throttle = await checkLoginThrottle(email);
  if (!throttle.allowed) {
    return NextResponse.json(
      { error: "Too many failed attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(Math.ceil(throttle.retryAfterMs / 1000)) } }
    );
  }

  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      passwordHash: users.passwordHash,
      passwordSalt: users.passwordSalt,
      name: users.name,
      role: users.role,
      color: users.color,
      avatarUrl: users.avatarUrl,
      isActive: users.isActive,
      authVersion: users.authVersion,
    })
    .from(users)
    .where(eq(users.email, String(email).toLowerCase().trim()))
    .limit(1);
  const u = rows[0];
  if (
    !u ||
    !u.isActive ||
    !verifyPassword(String(password), u.passwordHash, u.passwordSalt)
  ) {
    // Recorded even when the email doesn't match any account — the
    // identifier is the submitted string either way, so a nonexistent email
    // still throttles rather than being a free, unlimited guessing surface.
    await recordLoginFailure(email);
    return NextResponse.json(
      { error: "Invalid email or password." },
      { status: 401 }
    );
  }

  const res = NextResponse.json({
    user: {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      color: u.color,
      avatarUrl: u.avatarUrl,
    },
  });
  res.cookies.set(SESSION_COOKIE, signSession(u.id, u.authVersion), sessionCookieOptions());
  await logActivity(u.id, "login");
  return res;
}
