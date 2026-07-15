import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { adminOrNull } from "@/lib/admin";
import { logActivity } from "@/lib/activity";
import { writePrivateBuffer } from "@/lib/storage";

export const runtime = "nodejs";

function secretOk(req: NextRequest): boolean {
  const expected = process.env.SET_TOKEN_SECRET;
  const got = req.headers.get("x-setup-secret");
  if (!expected || !got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Seed/replace the Higgsfield MCP OAuth token in GCS (the serverless source of
 * truth). Recovery path when the token family dies: run `npm run hf:login`
 * locally, then POST the resulting .higgsfield-mcp-token.json here — as a
 * logged-in admin (Admin → Higgsfield token card) or with the
 * `x-setup-secret` header (scripts/upload-token-vercel.ts).
 */
export async function POST(req: NextRequest) {
  const admin = await adminOrNull();
  if (!admin && !secretOk(req)) {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  if (
    !body ||
    typeof body.access_token !== "string" ||
    typeof body.refresh_token !== "string" ||
    typeof body.client_id !== "string" ||
    !body.access_token ||
    !body.refresh_token ||
    !body.client_id
  ) {
    return NextResponse.json(
      { error: "Body must be the hf:login token JSON (access_token, refresh_token, client_id)." },
      { status: 400 }
    );
  }

  const tokenData = {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    client_id: body.client_id,
    expires_in: typeof body.expires_in === "number" ? body.expires_in : 86399,
    // Stamp the age — an age-less token would previously be treated as fresh
    // forever and never refreshed.
    obtained_at: typeof body.obtained_at === "number" ? body.obtained_at : Date.now(),
  };

  await writePrivateBuffer(
    Buffer.from(JSON.stringify(tokenData)),
    "settings/higgsfield-mcp-token.json",
    "application/json"
  );
  await logActivity(admin?.id ?? null, "set_higgsfield_token", {
    via: admin ? "admin-session" : "setup-secret",
  });
  return NextResponse.json({ ok: true });
}
