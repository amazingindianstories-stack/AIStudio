import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { readMaxPromptLength } from "@/lib/settings-db";

export const runtime = "nodejs";

/** Non-admin-gated settings every signed-in user needs client-side (e.g. the
 *  composer's live character counter) — separate from /api/admin/settings,
 *  which is where these values are edited. */
export async function GET() {
  if (!(await getSession()))
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  return NextResponse.json({ maxPromptLength: await readMaxPromptLength() });
}
