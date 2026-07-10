/**
 * Cost model. Each generation's cost is computed from the editable `pricing`
 * table (per-model) at generation time and stored on generations.costCents.
 *
 * Images are priced per_image, scaled by a resolution factor. Videos are priced
 * per_second × duration. All values are admin-editable; these are seed defaults
 * (placeholders — confirm against live Gemini / BytePlus pricing).
 */
export type PriceUnit = "per_image" | "per_second";

export interface PricingRow {
  model: string;
  unitCostCents: number;
  unit: PriceUnit;
  notes?: string | null;
}

export const DEFAULT_PRICING: PricingRow[] = [
  {
    model: "Nano Banana 2",
    unitCostCents: 5,
    unit: "per_image",
    notes:
      "Gemini 3.1 Flash Image (direct API); base = 1K, scaled by resolution factor",
  },
  {
    model: "Nano Banana Pro",
    unitCostCents: 14,
    unit: "per_image",
    notes: "Gemini 3 Pro Image; base = 1K, scaled by resolution factor",
  },
  {
    model: "Seedance 2.0",
    unitCostCents: 8,
    unit: "per_second",
    notes: "BytePlus Seedance standard",
  },
  {
    model: "Seedance 2.0 Mini",
    unitCostCents: 3,
    unit: "per_second",
    notes: "BytePlus Seedance fast/mini",
  },
  {
    model: "Higgsfield Nano Banana Pro",
    unitCostCents: 14,
    unit: "per_image",
    notes: "Nano Banana Pro via Higgsfield MCP (comparison test vs direct Gemini)",
  },
  {
    model: "Higgsfield Soul",
    unitCostCents: 10,
    unit: "per_image",
    notes: "Higgsfield Soul (photoreal); base = 720p, scaled by resolution factor",
  },
  {
    model: "Higgsfield Seedance 2.0",
    unitCostCents: 8,
    unit: "per_second",
    notes: "Seedance 2.0 multi-image via Higgsfield MCP (~3 credits/s)",
  },
  {
    model: "Higgsfield Seedance 2.0 Mini",
    unitCostCents: 0,
    unit: "per_second",
    notes:
      "Seedance 2.0 Mini via Higgsfield MCP — free under the unlimited-usage plan offer (2026-07); restore a real rate if the offer lapses",
  },
];

const RESOLUTION_FACTOR: Record<string, number> = {
  "1K": 1,
  "1080p": 1,
  "2K": 1.5,
  "4K": 3,
};

export interface CostInput {
  kind: "image" | "video";
  model: string;
  resolution?: string;
  duration?: number;
}

/** Compute the cost in cents for a generation from the pricing rows. */
export function computeCostCents(
  input: CostInput,
  pricing: PricingRow[]
): number {
  const row = pricing.find((p) => p.model === input.model);
  if (!row) return 0;
  if (row.unit === "per_second") {
    const seconds = input.duration ?? 0;
    return Math.round(row.unitCostCents * seconds);
  }
  // per_image
  const factor = input.resolution ? RESOLUTION_FACTOR[input.resolution] ?? 1 : 1;
  return Math.round(row.unitCostCents * factor);
}

/** "$1.23" from cents. */
export function formatCost(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
