/**
 * Spend-aware admission control for Gemini-backed generations.
 *
 * WHY THIS EXISTS
 * Google enforces a *spend-based* rate limit on the Gemini API, separate from
 * RPM/TPM/RPD: a rolling 10-minute window capped in dollars ($10/10min on
 * Tier 1, $200 on Tier 2/3), returning 429 RESOURCE_EXHAUSTED when crossed.
 * Measured 2026-07-28: a burst of 21:9/2K best-of-N jobs tripped it and
 * surfaced raw provider errors to users.
 *
 * Retrying cannot fix this, and it is important to understand why before
 * anyone "improves" the backoff in providers/gemini.ts instead. The window is
 * 10 minutes; a serverless invocation lives at most 300s (maxDuration on
 * /api/queue/execute). A saturated window therefore outlives any backoff that
 * can fit inside a single request — the job would sleep, wake, and 429 again.
 * The only real remedy is to not send the request at all: hold the job in the
 * queue we already have until the window has room. Backoff still earns its
 * keep against momentary spikes; this handles sustained load.
 *
 * WHAT THIS IS NOT
 * This is an *estimator*, not a meter. We cannot read Google's ledger, so jobs
 * are weighed by the app's own `pricing` table — whose seed values are
 * explicitly placeholders ("confirm against live Gemini / BytePlus pricing",
 * see pricing.ts). It therefore models *relative* cost well (a 4K render
 * against a 1K one) and absolute dollars only as well as that table is
 * calibrated. It is measurably under-calibrated today — see the derivation on
 * DEFAULT_SPEND_LIMIT_CENTS, where the burst that tripped a real $10 limit
 * scores only ~231 cents here. Two consequences:
 *   1. The default limit is set from that measured incident, NOT from Tier 1's
 *      nominal $10. Do not "correct" it upward to look like $10.
 *   2. If you still see 429s, the table is under-pricing reality further —
 *      calibrate against Cloud Billing (filter: Generative Language API)
 *      rather than assuming the limit here corresponds to a true $10.
 *
 * SPEND THIS DELIBERATELY CANNOT SEE
 * costCents covers renders only. The best-of-N judge (middleware/face-judge)
 * and role detection (middleware/image-prep) also call Gemini on the same key
 * and are not priced per row. That unmodelled spend is another reason the
 * default limit sits well under the real ceiling.
 */

/** Google evaluates spend on a rolling 10-minute window. */
export const SPEND_WINDOW_MS = 10 * 60 * 1000;

/**
 * Default budget, per rolling window, in ESTIMATOR cents — not real dollars.
 * Read the derivation before changing it; the obvious value is wrong.
 *
 * Tier 1's real ceiling is $10 per 10 minutes, so the naive default would be
 * ~1000 (or ~700 with margin). That would be useless here, and we can prove it
 * from the incident: the 2026-07-28 burst that actually tripped Google's limit
 * totals only ~231 cents when scored by this app's `pricing` table. A budget of
 * 700 would have admitted that entire burst unchanged.
 *
 * So the table under-reads reality by at least ~4.3× (231 estimator cents
 * bought ≥1000 real cents of Gemini spend). Working backwards from the one
 * datapoint we have:
 *
 *     1000 real cents / 4.3 ≈ 230 estimator cents ≈ the known-bad threshold
 *
 * 150 sits ~35% below that known-bad point. It is a floor derived from a single
 * measured incident, not a precise conversion — treat it as the starting point
 * for calibration, not an answer.
 *
 * TO CALIBRATE PROPERLY: run a batch, then compare the real charge in Cloud
 * Billing (filter: Generative Language API) against the estimator cents this
 * window scored. Adjust GEMINI_SPEND_LIMIT_CENTS by that ratio.
 *
 * RAISE THIS ON TIER 2. The ceiling becomes $200/10min — 20× — at which point
 * this gate should stop binding almost entirely. Roughly 3000 would preserve
 * the same safety margin; it is env-tunable precisely so that is a dashboard
 * change and not a deploy.
 */
export const DEFAULT_SPEND_LIMIT_CENTS = 150;

/** Just the shape these readers need, so tests can pass a bare object rather
 *  than fabricating a whole NodeJS.ProcessEnv. */

function positiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Budget per window. Env-tunable so the limit can be raised the moment the
 *  account tiers up, without a deploy. Set to 0 to disable the gate entirely. */
export function spendLimitCents(env = process.env) {
  const raw = env.GEMINI_SPEND_LIMIT_CENTS;
  if (raw !== undefined && Number(raw) === 0) return 0; // explicit opt-out
  return positiveInt(raw, DEFAULT_SPEND_LIMIT_CENTS);
}

/**
 * How many renders a single image job will actually issue.
 *
 * Best-of-N fans out N parallel renders per delivered image, so an image job's
 * true API spend is N× its stored costCents. Mirrors the clamp in
 * /api/queue/execute so the two cannot drift.
 */
export function bestOfMultiplier(env = process.env) {
  return Math.min(4, Math.max(1, Number(env.FACE_BEST_OF) || 2));
}

/**
 * Decide whether a job may start now.
 *
 * The `windowBusy` escape is a forward-progress guarantee, not a convenience:
 * without it, a single job whose own estimate exceeds the whole budget (a 4K
 * best-of-4, or simply a mis-calibrated pricing table) would be held forever,
 * because the window can never drain below its own cost. An empty window means
 * nothing else is in flight, so letting it through risks at most that one job's
 * spend — and a job that can never run is a worse failure than one 429.
 */
export function admits(i) {
  if (i.limitCents <= 0) return true; // gate disabled
  if (!i.windowBusy) return true; // forward-progress guarantee
  return i.windowCents + i.jobCents <= i.limitCents;
}

/**
 * How long until the window frees up, for the client's poll pacing.
 *
 * Spend leaves the window exactly SPEND_WINDOW_MS after the row that incurred
 * it was last touched, so the oldest in-window row is the soonest moment more
 * budget exists. Floored at 5s so a client can't busy-poll, capped at the
 * window length so a clock skew can't strand it.
 */
export function holdRetryAfterMs(
  oldestUpdatedAt,
  now
) {
  if (oldestUpdatedAt === null) return 5_000;
  const freesAt = oldestUpdatedAt + SPEND_WINDOW_MS;
  return Math.min(Math.max(freesAt - now, 5_000), SPEND_WINDOW_MS);
}

/** User-facing explanation for a held job. Deliberately blames the budget, not
 *  the user's prompt — a held job is healthy and will run on its own. */
export const HELD_MESSAGE =
  "Waiting for the API rate-limit window to clear — this will start automatically.";
