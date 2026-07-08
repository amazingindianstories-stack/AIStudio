import { eq } from "drizzle-orm";
import { db } from "./db";
import { pricing } from "./schema";
import type { PricingRow, PriceUnit } from "./pricing";

/** DB-backed pricing access (kept separate so pricing.ts stays client-safe). */

export async function readPricing(): Promise<PricingRow[]> {
  const rows = await db.select().from(pricing);
  return rows.map((r) => ({
    model: r.model,
    unitCostCents: r.unitCostCents,
    unit: r.unit as PriceUnit,
    notes: r.notes,
  }));
}

export async function updatePricing(
  model: string,
  unitCostCents: number,
  unit: PriceUnit
): Promise<void> {
  await db
    .insert(pricing)
    .values({ model, unitCostCents, unit })
    .onConflictDoUpdate({
      target: pricing.model,
      set: { unitCostCents, unit },
    });
}
