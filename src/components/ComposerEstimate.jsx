import { useEffect, useState } from "react";
import { requestJson } from "@/lib/api";
import { composerEstimate } from "@/lib/composer-estimate";
import { formatCost } from "@/lib/pricing";
import { parseAssetSlugs } from "@/lib/mentions";

export function ComposerEstimate({ state }) {
  const [pricing, setPricing] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    requestJson("/api/pricing", { cache: "no-store" })
      .then((data) => {
        if (!cancelled) setPricing(data.pricing);
      })
      .catch(() => {
        if (!cancelled) setPricing(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);
  const estimate = composerEstimate(
    {
      ...state,
      hasReferenceImage:
        state.referenceImages.length > 0 ||
        parseAssetSlugs(state.prompt).length > 0,
    },
    pricing,
  );
  return (
    <details className="min-w-0 text-xs text-white/80">
      <summary className="cursor-pointer rounded py-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
        {loading
          ? "Loading cost estimate…"
          : estimate.available
            ? `Estimated total: ≈${formatCost(estimate.totalCents)} USD · ${estimate.batch} ${estimate.batch === 1 ? "output" : "outputs"}`
            : "Estimate unavailable"}
      </summary>
      <div className="space-y-1 py-2 leading-5">
        {estimate.available ? (
          <p>
            Per output: {formatCost(estimate.baseCents)} base +{" "}
            {formatCost(estimate.audioCents)} separate audio surcharge. Batch:{" "}
            {estimate.batch} × {formatCost(estimate.eachCents)}.
          </p>
        ) : (
          <p>{estimate.reason}</p>
        )}
        <p>
          Estimated internal cost from configured rates, not an invoice or
          customer charge. Actual usage, additional candidates and provider fees
          may differ.
          {estimate.tokenBased &&
            " This model is reconciled using actual tokens; audio is included in that usage."}
        </p>
        <button
          type="button"
          disabled={loading}
          onClick={() => setAttempt((n) => n + 1)}
          className="underline"
        >
          Refresh rates
        </button>
      </div>
    </details>
  );
}
