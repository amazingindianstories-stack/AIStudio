import { NextRequest, NextResponse } from "next/server";
import { adminOrNull } from "@/lib/admin";
import { updateMaxPromptLength } from "@/lib/settings-db";

export const runtime = "nodejs";

/** Update an admin-editable setting. Body: { maxPromptLength }. Single-purpose
 *  for now (mirrors pricing's route) — add more fields here as more admin
 *  controls land on the same settings table rather than adding new routes. */
export async function POST(req: NextRequest) {
  if (!(await adminOrNull()))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  const maxPromptLength = Math.round(Number(b.maxPromptLength));
  if (!Number.isFinite(maxPromptLength) || maxPromptLength < 1) {
    return NextResponse.json({ error: "Invalid max prompt length." }, { status: 400 });
  }
  await updateMaxPromptLength(maxPromptLength);
  return NextResponse.json({ ok: true });
}
