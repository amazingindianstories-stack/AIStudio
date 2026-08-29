import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { adminOrNull } from "@/lib/admin";
import { SESSION_COOKIE } from "@/lib/auth";
import { claimDistributedLease } from "@/lib/distributed-lease";
import { runRuntimeAudit } from "@/lib/runtime-audit";

export const runtime = "nodejs";
export const maxDuration = 60;

const COOLDOWN_MS = 60_000;

export async function POST(req) {
  const admin = await adminOrNull();
  if (!admin) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const owner = randomUUID();
  const claimed = await claimDistributedLease("lease:admin-runtime-audit", owner, {
    ttlMs: COOLDOWN_MS,
  });
  if (!claimed) {
    return NextResponse.json(
      { error: "COOLDOWN", retryAfterSeconds: Math.ceil(COOLDOWN_MS / 1000) },
      { status: 429, headers: { "Retry-After": String(Math.ceil(COOLDOWN_MS / 1000)) } }
    );
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const adminCookie = token ? `${SESSION_COOKIE}=${token}` : "";
  const response = await runRuntimeAudit({
    origin: req.nextUrl.origin,
    adminCookie,
    adminId: admin.id,
  });
  return NextResponse.json(response, { headers: { "Cache-Control": "no-store" } });
}
