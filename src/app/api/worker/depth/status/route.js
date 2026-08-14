import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { readDepthWorkerStatus } from "@/lib/depth-jobs-db";

export const runtime = "nodejs";

/** Browser-facing (session-authed, unlike the /api/worker/depth/* routes
 *  above which are worker-authed) — this is what the composer's status pill
 *  polls. Kept as its own route rather than folding into /api/settings so it
 *  can be polled on its own short interval without dragging limits/pricing
 *  along for the ride. */
export async function GET() {
  const user = await getSession();
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const status = await readDepthWorkerStatus();
  return NextResponse.json(status);
}
