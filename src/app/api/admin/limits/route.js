import { NextResponse } from "next/server";
import { adminOrNull } from "@/lib/admin";
import { limitDefinition } from "@/lib/limits";
import { updateGlobalLimit } from "@/lib/limits-db";

export const runtime = "nodejs";

/** Update the global default for one registered limit (src/lib/limits.ts).
 *  Body: { key, value }. Generic across every limit type — adding a new
 *  limit to the registry needs no change here. Per-user overrides are a
 *  separate route, /api/admin/user-limits. */
export async function POST(req) {
  if (!(await adminOrNull()))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  const key = typeof b.key === "string" ? b.key : "";
  const def = limitDefinition(key);
  if (!def) return NextResponse.json({ error: "Unknown limit." }, { status: 400 });
  const value = Math.round(Number(b.value));
  if (!Number.isFinite(value) || value < def.min) {
    return NextResponse.json({ error: `Invalid ${def.label.toLowerCase()}.` }, { status: 400 });
  }
  await updateGlobalLimit(key, value);
  return NextResponse.json({ ok: true });
}
