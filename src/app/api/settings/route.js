import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { readEffectiveMaxPromptLength } from "@/lib/settings-db";

export const runtime = "nodejs";

/** Non-admin-gated settings every signed-in user needs client-side (e.g. the
 *  composer's live character counter) — separate from /api/admin/settings,
 *  which is where these values are edited. Returns the EFFECTIVE limit for
 *  the caller specifically (their personal override if an admin set one,
 *  else the global default), not the flat global value — two users can see
 *  different numbers here by design. */
export async function GET() {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  return NextResponse.json({ maxPromptLength: await readEffectiveMaxPromptLength(user.id) });
}
