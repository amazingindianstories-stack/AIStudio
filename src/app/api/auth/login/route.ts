import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { users } from "@/lib/schema";
import {
  verifyPassword,
  signSession,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
} from "@/lib/auth";
import { logActivity } from "@/lib/activity";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const db = await getDb();
  const { email, password } = await req.json().catch(() => ({}));
  if (!email || !password) {
    return NextResponse.json(
      { error: "Email and password are required." },
      { status: 400 }
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
  res.cookies.set(SESSION_COOKIE, signSession(u.id, u.authVersion), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  await logActivity(u.id, "login");
  return res;
}
