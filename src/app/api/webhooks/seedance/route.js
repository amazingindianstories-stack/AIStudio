import { NextResponse } from "next/server";
import { getItemByTaskId } from "@/lib/store-db";
import { advanceVideoStatus } from "@/lib/video-status-advancement";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * BytePlus callback receiver. BytePlus POSTs the same task object returned by
 * GET /contents/generations/tasks/{id}. The callback is server-to-server, so
 * it continues to work after the artist closes the browser. A status read is
 * performed after locating the row so the existing persistence, storage and
 * billing state machine remains the single source of truth.
 */
export async function POST(request) {
  const expected = process.env.SEEDANCE_CALLBACK_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "CALLBACK_NOT_CONFIGURED" }, { status: 503 });
  }
  const supplied = request.nextUrl.searchParams.get("token");
  if (!supplied || supplied !== expected) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  const taskId = payload?.id || payload?.task_id || payload?.data?.id;
  if (!taskId) return NextResponse.json({ error: "Missing task id." }, { status: 400 });

  const item = await getItemByTaskId(taskId);
  // A callback can race the queue transaction that saves taskId. Returning
  // 202 asks BytePlus to retry rather than dropping the completion.
  if (!item) return NextResponse.json({ accepted: false }, { status: 202 });

  const outcome = await advanceVideoStatus(item, { source: "callback" });
  return NextResponse.json(
    { accepted: true, taskId, outcome: outcome.kind },
    { headers: { "Cache-Control": "no-store" } },
  );
}
