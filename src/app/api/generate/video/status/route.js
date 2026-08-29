import { NextResponse } from "next/server";
import { getItem } from "@/lib/store-db";
import { advanceVideoStatus } from "@/lib/video-status-advancement";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(req) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id." }, { status: 400 });

  const item = await getItem(id);
  if (!item) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (["succeeded", "failed"].includes(item.status)) return NextResponse.json(item);

  const outcome = await advanceVideoStatus(item, { source: "browser" });
  if (outcome.kind === "poll_error") {
    return NextResponse.json({
      transientPollError: true,
      pollErrorCount: outcome.pollErrorCount,
      retryAfterMs: outcome.retryAfterMs,
    }, { headers: { "Cache-Control": "no-store" } });
  }
  if (outcome.kind === "raced") {
    const current = await getItem(id);
    return current
      ? NextResponse.json(current, { headers: { "Cache-Control": "no-store" } })
      : NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  return NextResponse.json(outcome.item, { headers: { "Cache-Control": "no-store" } });
}
