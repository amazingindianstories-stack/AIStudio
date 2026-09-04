import { NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/cron-auth";
import { reapStaleDepthJobs } from "@/lib/depth-jobs-db";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const reaped = await reapStaleDepthJobs({ force: true });
  console.info(JSON.stringify({ event: "depth_reconciliation", reaped }));
  return NextResponse.json({ reaped }, { headers: { "Cache-Control": "no-store" } });
}
