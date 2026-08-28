import { NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/cron-auth";
import { cleanupExpiredLoginAttempts } from "@/lib/login-throttle";

export const runtime = "nodejs";

export async function GET(request) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  const deleted = await cleanupExpiredLoginAttempts();
  console.info(JSON.stringify({
    event: "maintenance_cleanup",
    target: "login_attempts",
    deleted,
  }));
  return NextResponse.json({ ok: true, deleted });
}

