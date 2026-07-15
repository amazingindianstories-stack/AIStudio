import { NextResponse } from "next/server";
import { adminOrNull } from "@/lib/admin";
import { runAllChecks } from "@/lib/status-checks";

export const runtime = "nodejs";

/** Live health check across all six external dependencies. Admin-only, same
 *  gate as every other /api/admin/* route. No persistence — v1 is live-only. */
export async function GET() {
  const me = await adminOrNull();
  if (!me) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  return NextResponse.json(await runAllChecks());
}
