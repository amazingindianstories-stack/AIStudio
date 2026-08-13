import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { readAllEffectiveLimits } from "@/lib/limits-db";

export const runtime = "nodejs";

/** Non-admin-gated limits every signed-in user needs client-side (e.g. the
 *  composer's live character counter) — separate from /api/admin/limits and
 *  /api/admin/user-limits, which is where these are edited. Returns the
 *  EFFECTIVE value of every registered limit (src/lib/limits.ts) for the
 *  caller specifically — personal override if an admin set one, else the
 *  global default — so two users can see different numbers by design, and
 *  a new limit type shows up here automatically with no route change. */
export async function GET() {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  return NextResponse.json(await readAllEffectiveLimits(user.id));
}
