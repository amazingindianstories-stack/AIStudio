import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import {
  getSession,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  signSession,
} from "@/lib/auth";
import { getDb } from "@/lib/db";
import { users } from "@/lib/schema";
import { hashPassword, validatePassword, verifyPassword } from "@/lib/password";
import { logActivity } from "@/lib/activity";

export const runtime = "nodejs";

function clearSession(response: NextResponse): NextResponse {
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return response;
}

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return clearSession(
      NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 })
    );
  }
  const db = await getDb();

  const body = await req.json().catch(() => ({}));
  const currentPassword = body.currentPassword;
  const newPassword = body.newPassword;
  if (typeof currentPassword !== "string" || !currentPassword || currentPassword.length > 1024) {
    return NextResponse.json(
      { error: "Current password is required." },
      { status: 400 }
    );
  }
  const passwordError = validatePassword(newPassword);
  if (passwordError) {
    return NextResponse.json({ error: passwordError }, { status: 400 });
  }

  const [account] = await db
    .select({
      id: users.id,
      passwordHash: users.passwordHash,
      passwordSalt: users.passwordSalt,
      isActive: users.isActive,
      authVersion: users.authVersion,
    })
    .from(users)
    .where(eq(users.id, session.id))
    .limit(1);

  if (
    !account ||
    !account.isActive ||
    account.authVersion !== session.authVersion
  ) {
    return clearSession(
      NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 })
    );
  }
  if (!verifyPassword(currentPassword, account.passwordHash, account.passwordSalt)) {
    return NextResponse.json(
      { error: "Current password is incorrect." },
      { status: 401 }
    );
  }

  const { hash, salt } = hashPassword(newPassword);
  const [updated] = await db
    .update(users)
    .set({
      passwordHash: hash,
      passwordSalt: salt,
      authVersion: sql`${users.authVersion} + 1`,
    })
    .where(
      and(
        eq(users.id, account.id),
        eq(users.isActive, true),
        eq(users.authVersion, account.authVersion)
      )
    )
    .returning({ authVersion: users.authVersion });

  if (!updated) {
    return clearSession(
      NextResponse.json(
        { error: "Your session changed. Sign in and try again." },
        { status: 409 }
      )
    );
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(
    SESSION_COOKIE,
    signSession(session.id, updated.authVersion),
    {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: SESSION_MAX_AGE_SECONDS,
    }
  );
  await logActivity(session.id, "password_changed");
  return response;
}
