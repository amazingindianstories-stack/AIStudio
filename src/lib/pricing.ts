/**
 * Cost model. Each generation's cost is computed from the editable `pricing`
 * table (per-model) at generation time and stored on generations.costCents.
 *
 * Images are priced per_image, scaled by a resolution factor. Videos are priced
 * per_second × duration × resolution factor, plus an optional per-second audio
 * surcharge. All values are admin-editable; these are seed defaults
 * (placeholders — confirm against live Gemini / BytePlus pricing).
 *
 * Cost is computed and STORED on the row at generation time, so editing a rate
 * changes future generations only — historical attribution is never rewritten
 * underneath the admin dashboard's totals.
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
    notes: "BytePlus Seedance standard — base rate at 720p; 480p/1080p scale by VIDEO_RESOLUTION_FACTOR",
  },
  {
    model: "Seedance 2.0 Mini",
    unitCostCents: 3,
    unit: "per_second",
    notes: "BytePlus Seedance fast/mini — base rate at 720p; 480p scales by VIDEO_RESOLUTION_FACTOR",
  },
  {
    // Charged in ADDITION to the video, at the same duration. BytePlus does not
    // publish a separate audio line, so this is an unverified placeholder —
    // calibrate it from a real invoice. Set it to 0 to stop billing audio.
    model: "Seedance 2.0 · audio",
    unitCostCents: 2,
    unit: "per_second",
    notes: "PLACEHOLDER — audio surcharge added on top of Seedance 2.0; not yet verified against an invoice",
  },
  {
    model: "Seedance 2.0 Mini · audio",
    unitCostCents: 1,
    unit: "per_second",
    notes: "PLACEHOLDER — audio surcharge added on top of Seedance 2.0 Mini; not yet verified against an invoice",
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
    unitCostCents: 7,
    unit: "per_second",
    notes:
      "Seedance 2.0 Mini via Higgsfield MCP — measured 2.5 credits/s at 720p (1/s at 480p). The web 'Mini Unlimited' offer does NOT apply to MCP/API jobs.",
  },
  {
    model: "Gemini Omni Flash",
    unitCostCents: 10,
    unit: "per_second",
    notes:
      "gemini-omni-flash-preview (Interactions API); ~$0.10/s 720p output; duration prompt-driven, billed by requested seconds",
  },
];

const RESOLUTION_FACTOR: Record<string, number> = {
  "1K": 1,
  "1080p": 1,
  "2K": 1.5,
  "4K": 3,
};

export interface CostInput {
  /** Video only: whether an audio track was requested, which ModelArk bills on
   *  top of the video. */
  generateAudio?: boolean;
  kind: "image" | "video";
  model: string;
  resolution?: string;
  duration?: number;
}

/** Compute the cost in cents for a generation from the pricing rows. */
/**
 * Video cost scales with resolution, which the flat `rate × seconds` model
 * ignored entirely — a 15s 480p clip and a 15s 1080p clip recorded the same
 * cost, so per-user attribution was wrong by up to ~5× in either direction.
 *
 * BytePlus ModelArk bills Seedance by tokens, and tokens scale with pixels ×
 * frames, so the ratios here are derived from pixel counts adjusted by the
 * published per-token rates (720p $4.3/1M vs 1080p $4.7/1M with video input):
 *
 *   480p→720p   (1280×720)/(854×480)  = 2.25× pixels             → 480p ≈ 0.44
 *   720p→1080p  (1920×1080)/(1280×720)= 2.25× pixels × 1.09 rate → 1080p ≈ 2.46
 *
 * Still an ESTIMATE — the real bill depends on the account's tier and on token
 * accounting we cannot see from here. The base rate stays admin-editable so the
 * whole curve can be calibrated from one number once real invoices land.
 */
export const VIDEO_RESOLUTION_FACTOR: Record<string, number> = {
  "480p": 0.44,
  "720p": 1,
  "1080p": 2.46,
};

/** Pricing row holding the per-second surcharge for a model's audio track.
 *  A row rather than a column so it is admin-editable through the existing
 *  Pricing tab with no schema change. */
export function audioRowModel(model: string): string {
  return `${model} · audio`;
}

export function computeCostCents(
  input: CostInput,
  pricing: PricingRow[]
): number {
  const row = pricing.find((p) => p.model === input.model);
  if (!row) return 0;
  if (row.unit === "per_second") {
    const seconds = input.duration ?? 0;
    const factor = input.resolution
      ? VIDEO_RESOLUTION_FACTOR[input.resolution] ?? 1
      : 1;
    let cents = row.unitCostCents * seconds * factor;
    // Audio is billed on top of the video, so it is added at the same
    // duration — not folded into the base rate, which would overcharge every
    // silent generation.
    if (input.generateAudio) {
      const audio = pricing.find((p) => p.model === audioRowModel(input.model));
      if (audio) cents += audio.unitCostCents * seconds;
    }
    return Math.round(cents);
  }
  // per_image
  const factor = input.resolution ? RESOLUTION_FACTOR[input.resolution] ?? 1 : 1;
  return Math.round(row.unitCostCents * factor);
}

/** "$1.23" from cents. */
export function formatCost(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
