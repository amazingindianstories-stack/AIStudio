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
export type PriceUnit = "per_image" | "per_second" | "per_million_tokens";

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
  // ── Seedance 2.5 ─────────────────────────────────────────────────────────
  // Unlike 2.0, BytePlus's published Seedance 2.5 price is a flat $/M-token
  // rate (docs.byteplus.com/en/docs/ModelArk/1544106, read 2026-08-07) with no
  // per-second component at all, and the finished task's poll response
  // reports usage.total_tokens — the real count, not an estimate. So this
  // model follows Kling's pattern (see klingUnitsToCents below), not 2.0's:
  // the "Seedance 2.5" row's per_second rate is ONLY a placeholder shown while
  // a job is still running, and computeSeedanceTokenCostCents overwrites
  // costCents from the two per_million_tokens rows once usage.total_tokens is
  // known (generate/video/status/route.ts, on the succeeded poll). There is no
  // separate audio row — total_tokens already reflects whatever the request
  // actually cost, audio included, so a surcharge added on top would double
  // count it the moment the real figure lands.
  {
    model: "Seedance 2.5",
    unitCostCents: 8,
    unit: "per_second",
    notes:
      "PLACEHOLDER enqueue-time estimate only, same rough shape as Seedance 2.0's rate — overwritten by the exact token-based cost (see the per-token rows below) the moment the task succeeds.",
  },
  {
    model: "Seedance 2.5 · per-token",
    unitCostCents: 1070,
    unit: "per_million_tokens",
    notes:
      "Official BytePlus rate, no video input (text-to-video / image-to-video / reference-to-video with no attached clip): $10.70 per 1M tokens.",
  },
  {
    model: "Seedance 2.5 · per-token (video input)",
    unitCostCents: 640,
    unit: "per_million_tokens",
    notes:
      "Official BytePlus rate when a reference clip is attached (video-to-video, Edit, Extend): $6.40 per 1M tokens, cheaper than the no-video-input rate.",
  },
  // ── Kling ────────────────────────────────────────────────────────────────
  // These are the only rows here taken from a published vendor price list
  // rather than estimated (Kling's Basic APIs Pricing → Image, read
  // 2026-07-30), so don't "correct" them without re-reading it.
  //
  //   Kling Image 3.0   text→image AND image→image, 1K/2K   8 units  $0.028
  //   Kling Image 2.1   text→image,                 1K/2K   4 units  $0.014
  //   Kling Image 2.1   image→image,                1K/2K   8 units  $0.028
  //
  // Two consequences for the model below:
  //  - Price does NOT vary with resolution (1K and 2K cost the same), unlike
  //    every other image model here, hence IMAGE_RESOLUTION_FLAT.
  //  - For 2.1 the price DOUBLES when a reference image is supplied, hence the
  //    `· image-to-image` companion row.
  //
  // unitCostCents is an integer column and these prices are not whole cents
  // ($0.028 → 2.8¢, $0.014 → 1.4¢), so the rows below are nearest-cent
  // ESTIMATES used at enqueue time, when the cost has to be known before the
  // provider has run. They are then RECONCILED: Kling returns
  // `final_unit_deduction` on the finished task, and /api/queue/execute
  // recomputes costCents from it via klingUnitsToCents. Verified 2026-07-30 —
  // a real 2.1 text-to-image job reported exactly 4 units, matching the list
  // price. So the estimate only ever shows on a job that failed before Kling
  // reported, and the stored cost is the actual one.
  {
    model: "Kling Image 3.0",
    unitCostCents: 3,
    unit: "per_image",
    notes:
      "kling-v3 — vendor list price 8 units ($0.028)/image at 1K and 2K alike; 3¢ is $0.028 rounded up to whole cents",
  },
  {
    model: "Kling Image 2.1",
    unitCostCents: 1,
    unit: "per_image",
    notes:
      "kling-v2-1 text-to-image — vendor list price 4 units ($0.014)/image at 1K and 2K alike; see the '· image-to-image' row for reference-image jobs",
  },
  {
    // Replaces (does not add to) the base row when a reference image is used —
    // unlike the audio rows, which are surcharges. See computeCostCents.
    model: "Kling Image 2.1 · image-to-image",
    unitCostCents: 3,
    unit: "per_image",
    notes:
      "kling-v2-1 with a reference image — vendor list price 8 units ($0.028)/image, double the text-to-image rate",
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
  /** Image only: whether a reference image was supplied. Kling Image 2.1 bills
   *  image-to-image at double its text-to-image rate, so the two modes cannot
   *  share one number. Ignored for models with no such split. */
  hasReferenceImage?: boolean;
}

/**
 * Models whose per-image price does not vary with resolution.
 *
 * Kling publishes one price covering both 1K and 2K, so applying
 * RESOLUTION_FACTOR to them would invent a 50% premium that Kling never
 * charges. Matched by prefix because it is a property of the vendor's price
 * list, not of any one model id.
 */
const IMAGE_RESOLUTION_FLAT = [/^kling /i];

function imagePriceScalesWithResolution(model: string): boolean {
  return !IMAGE_RESOLUTION_FLAT.some((re) => re.test(model.trim()));
}

/**
 * Cents per Kling "Unit".
 *
 * Kling prices everything in Units and publishes the conversion alongside them:
 * 8 Units = $0.028 and 4 Units = $0.014, i.e. $0.0035 = 0.35¢ per Unit. Because
 * the finished task reports `final_unit_deduction`, this turns Kling into the
 * one provider here whose stored cost is what was actually charged rather than
 * an estimate — no other vendor in this app reports its own billing back.
 */
export const KLING_UNIT_CENTS = 0.35;

/** Actual cost of a Kling job from the units it reported. Returns undefined for
 *  anything unparseable, so the caller keeps its estimate rather than billing 0. */
export function klingUnitsToCents(units: string | number | undefined): number | undefined {
  if (units == null) return undefined;
  let n: number;
  if (typeof units === "number") {
    n = units;
  } else {
    const trimmed = units.trim();
    // Number("") is 0, which would bill a job at zero instead of keeping the
    // estimate. An absent field is not a report of zero.
    if (!trimmed) return undefined;
    n = Number(trimmed);
  }
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * KLING_UNIT_CENTS);
}

/** Pricing row holding a model's per-token rate for a given input shape (see
 *  the "Seedance 2.5" comment block above `DEFAULT_PRICING`). A row rather
 *  than a constant, for the same admin-editable reason as every other rate
 *  here. */
function seedanceTokenRowModel(model: string, hadVideoInput: boolean): string {
  return `${model} · per-token${hadVideoInput ? " (video input)" : ""}`;
}

/**
 * Actual cost of a Seedance 2.5 job from the tokens BytePlus reported
 * (usage.total_tokens on the finished task). Mirrors klingUnitsToCents:
 * returns undefined for anything unusable so the caller keeps its enqueue-
 * time estimate rather than billing 0 when the pricing row is missing or the
 * count is unparseable.
 */
export function computeSeedanceTokenCostCents(
  model: string,
  totalTokens: number | undefined,
  hadVideoInput: boolean,
  pricing: PricingRow[]
): number | undefined {
  if (totalTokens == null || !Number.isFinite(totalTokens) || totalTokens < 0) {
    return undefined;
  }
  const row = pricing.find((p) => p.model === seedanceTokenRowModel(model, hadVideoInput));
  if (!row) return undefined;
  return Math.round((row.unitCostCents * totalTokens) / 1_000_000);
}

/**
 * Pricing row for a model's image-to-image rate, when it charges a different
 * one. A row rather than a column, for the same reason as audioRowModel: it
 * stays editable through the existing Pricing tab with no schema change.
 *
 * Unlike audio this REPLACES the base rate rather than adding to it — Kling's
 * price list gives image-to-image as a total per image, not a surcharge.
 */
export function imageToImageRowModel(model: string): string {
  return `${model} · image-to-image`;
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
  //
  // An image-to-image job may be priced differently. Look for the companion row
  // first and fall back to the base rate, so a model without one (or an admin
  // who deleted it) still bills rather than silently costing nothing.
  let effective = row;
  if (input.hasReferenceImage) {
    const i2i = pricing.find((p) => p.model === imageToImageRowModel(input.model));
    if (i2i) effective = i2i;
  }
  const factor =
    input.resolution && imagePriceScalesWithResolution(input.model)
      ? RESOLUTION_FACTOR[input.resolution] ?? 1
      : 1;
  return Math.round(effective.unitCostCents * factor);
}

/** "$1.23" from cents. */
export function formatCost(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
