import { NextResponse } from "next/server";
import { getItem } from "@/lib/store-db";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(req) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id." }, { status: 400 });

  const item = await getItem(id);
  if (!item) return NextResponse.json({ error: "Not found." }, { status: 404 });
  // Read-only resync endpoint. Provider reads and terminal persistence belong
  // to the durable worker; this route never advances a generation.
  // Legacy response contract retained for clients that display sanitized
  // transientPollError: true, pollErrorCount: outcome.pollErrorCount, and
  // retryAfterMs: outcome.retryAfterMs fields.
  return NextResponse.json({
    ...item,
    transientPollError: item.lastPollErrorAt != null ? true : false,
    pollErrorCount: item.pollErrorCount ?? 0,
    retryAfterMs: item.nextPollAt ? Math.max(0, item.nextPollAt - Date.now()) : 0,
  }, { headers: { "Cache-Control": "no-store" } });
}
