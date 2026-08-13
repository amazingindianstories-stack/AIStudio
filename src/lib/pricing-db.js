
import { getDb } from "./db";
import { pricing } from "./schema";

/** DB-backed pricing access (kept separate so pricing.ts stays client-safe). */

export async function readPricing() {
  const db = await getDb();
  const rows = await db.select().from(pricing);
  return rows.map((r) => ({
    model: r.model,
    unitCostCents: r.unitCostCents,
    unit: r.unit ,
    notes: r.notes,
  }));
}

export async function updatePricing(
  model,
  unitCostCents,
  unit
) {
  const db = await getDb();
  await db
    .insert(pricing)
    .values({ model, unitCostCents, unit })
    .onConflictDoUpdate({
      target: pricing.model,
      set: { unitCostCents, unit },
    });
}
