import {
  computeCostCents,
  audioRowModel,
  imageToImageRowModel,
} from "./pricing";
import { getModelDefinition } from "./model-registry";

/** Uses configured rates, never seed defaults. Missing data is not zero cost. */
export function composerEstimate(input, pricing) {
  if (!Array.isArray(pricing))
    return { available: false, reason: "Rates could not be loaded." };
  if (input.videoTaskMode === "edit")
    return {
      available: false,
      reason:
        "Clip editing is billed from the source duration and actual usage.",
    };
  const model = getModelDefinition(input.model);
  const key = model?.pricingKey ?? input.model;
  const base = pricing.find((p) => p.model === key);
  const valid = (row) =>
    row && Number.isFinite(row.unitCostCents) && row.unitCostCents >= 0;
  if (!valid(base))
    return { available: false, reason: "No configured rate for this model." };
  if (
    input.hasReferenceImage &&
    model?.imageToImagePricingKey &&
    !valid(pricing.find((p) => p.model === imageToImageRowModel(input.model)))
  )
    return { available: false, reason: "Reference-image rate unavailable." };
  if (
    input.generateAudio &&
    model?.audioPricingKey &&
    !valid(pricing.find((p) => p.model === audioRowModel(input.model)))
  )
    return { available: false, reason: "Audio rate unavailable." };
  if (
    base.unit === "per_second" &&
    (!Number.isFinite(input.duration) || input.duration <= 0)
  )
    return { available: false, reason: "Duration is not yet known." };
  const baseCents = computeCostCents(
    { ...input, generateAudio: false },
    pricing,
  );
  const eachCents = computeCostCents(input, pricing);
  const batch = Math.min(4, Math.max(1, input.batchCount || 1));
  return {
    available: true,
    baseCents,
    audioCents: eachCents - baseCents,
    eachCents,
    batch,
    totalCents: eachCents * batch,
    tokenBased: Boolean(model?.tokenPricingKey),
  };
}
