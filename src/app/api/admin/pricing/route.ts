import { NextRequest, NextResponse } from "next/server";
import { adminOrNull } from "@/lib/admin";
import { updatePricing } from "@/lib/pricing-db";

export const runtime = "nodejs";

/** Update a pricing row. Body: { model, unitCostCents, unit } */
export async function POST(req: NextRequest) {
  if (!(await adminOrNull()))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  const b = await req.json().catch(() => ({}));
  const model = String(b.model || "").trim();
  const unitCostCents = Math.max(0, Math.round(Number(b.unitCostCents)));
  const unit = b.unit === "per_second" ? "per_second" : "per_image";
  if (!model || !Number.isFinite(unitCostCents))
    return NextResponse.json({ error: "Invalid pricing." }, { status: 400 });
  await updatePricing(model, unitCostCents, unit);
  return NextResponse.json({ ok: true });
}
