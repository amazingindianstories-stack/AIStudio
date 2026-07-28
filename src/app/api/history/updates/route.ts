import { NextRequest, NextResponse } from "next/server";
import { readGenerationUpdates } from "@/lib/store-db";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * Live-update feed for the client's generation poller.
 *
 * Answers "what has changed since `since`, and what is still in flight?" in one
 * cheap round trip, so a client no longer has to be the tab that started a job
 * in order to see it finish. Before this, per-job pollers were only ever
 * attached to items the tab already knew about (store.ts startPolling, called
 * on submit and on loadHistory), which meant a job started in another tab, on
 * another device, or by a teammate never updated here at all — and history is
 * team-wide, so that is the common case, not an edge case.
 *
 * Auth is checked explicitly rather than relying on src/middleware.ts, which is
 * only an edge presence-check — see the auth notes in CLAUDE.md.
 *
 * Deliberately returns whole rows, not a diff. The rows are small, the client
 * merges by id, and a diff format would add a second source of truth about
 * generation shape for no measurable gain.
 */
export async function GET(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }
  const raw = req.nextUrl.searchParams.get("since");
  const parsed = Number(raw);
  // A missing or junk watermark must not become `> NaN` (which matches
  // nothing) or `> 0` (which returns the entire table). Fall back to a short
  // look-back: enough to catch anything that finished around a page load.
  const since =
    Number.isFinite(parsed) && parsed > 0 ? parsed : Date.now() - 5 * 60_000;

  const items = await readGenerationUpdates(since);
  // `now` is the watermark for the client's next poll. It comes from the
  // server so a skewed client clock can't skip or endlessly re-fetch changes.
  return NextResponse.json({ items, now: Date.now() });
}
