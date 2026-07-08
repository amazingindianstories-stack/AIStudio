import { NextResponse } from "next/server";
import { getSession, SESSION_COOKIE } from "@/lib/auth";
import { logActivity } from "@/lib/activity";

export const runtime = "nodejs";

export async function POST() {
  const user = await getSession();
  if (user) await logActivity(user.id, "logout");
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
