import { NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/cron-auth";
import { reconciliationTelemetry, runVideoReconciliation } from "@/lib/video-reconciliation";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const counts = await runVideoReconciliation();
  console.info(JSON.stringify(reconciliationTelemetry(counts)));
  return NextResponse.json(counts, { headers: { "Cache-Control": "no-store" } });
}
