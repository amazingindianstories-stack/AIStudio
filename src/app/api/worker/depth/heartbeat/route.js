import { NextResponse } from "next/server";
import { verifyWorkerToken } from "@/lib/depth-worker-auth";
import { upsertDepthWorkerHeartbeat } from "@/lib/depth-jobs-db";

export const runtime = "nodejs";

/**
 * Called by the worker every ~15s (idle or busy) so the status pill's
 * "online" derivation (see depth-jobs-db.js WORKER_STALE_MS) has something
 * fresh to read. Also carries the RAM figures the worker is self-capping to,
 * so the pill can show "18.2 / 32 GB" rather than just a dot.
 */
export async function POST(req) {
  if (!verifyWorkerToken(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const workerId = (body.workerId || "").trim();
  if (!workerId) {
    return NextResponse.json({ error: "workerId is required." }, { status: 400 });
  }
  await upsertDepthWorkerHeartbeat({
    workerId,
    label: typeof body.label === "string" ? body.label.slice(0, 200) : undefined,
    device: typeof body.device === "string" ? body.device.slice(0, 50) : undefined,
    status: body.status === "busy" ? "busy" : "idle",
    currentJobId: typeof body.currentJobId === "string" ? body.currentJobId : undefined,
    ramLimitMb: Number.isFinite(body.ramLimitMb) ? Math.round(body.ramLimitMb) : undefined,
    ramUsedMb: Number.isFinite(body.ramUsedMb) ? Math.round(body.ramUsedMb) : undefined,
  });
  return NextResponse.json({ ok: true });
}
