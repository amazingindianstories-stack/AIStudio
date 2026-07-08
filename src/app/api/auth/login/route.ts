import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/schema";
import { verifyPassword, signSession, SESSION_COOKIE } from "@/lib/auth";
import { logActivity } from "@/lib/activity";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const { email, password } = await req.json().catch(() => ({}));
  if (!email || !password) {
    return NextResponse.json(
      { error: "Email and password are required." },
      { status: 400 }
    );
  }
  const rows = await db
    .select()
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
    user: { id: u.id, email: u.email, name: u.name, role: u.role, color: u.color },
  });
  res.cookies.set(SESSION_COOKIE, signSession(u.id), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  await logActivity(u.id, "login");
  return res;
}
