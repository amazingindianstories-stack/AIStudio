/**
 * Registry of admin-configurable limits — client-safe (no DB imports, same
 * reasoning as pricing.ts vs pricing-db.ts). This is the one place a new
 * limit type gets added: both the global Limits tab and the per-user limits
 * panel in the Users tab render themselves entirely from this list, so
 * neither needs new UI code for a limit that fits this shape (a number with
 * a global default and an optional per-user override) — which is every
 * limit here by design, that being the point of the registry.
 */

export const LIMIT_DEFINITIONS = [
  {
    key: "maxPromptLength",
    label: "Max prompt length",
    description:
      "Rejects an image or video generation request if its prompt exceeds this many characters — enforced server-side regardless of what the composer shows. Some models (Kling) already enforce their own tighter, non-configurable cap on top of whichever limit applies.",
    unit: "characters",
    // High enough that no prompt in real use today, including the longest
    // video shot-spec prompts (~18-21KB per CLAUDE.md), is retroactively
    // blocked the moment this ships.
    defaultValue: 30000,
    min: 1,
  },
  {
    key: "maxConcurrentJobs",
    label: "Max concurrent jobs",
    description:
      "Maximum running jobs per user and job kind. The global image/video caps still apply, so this prevents one user from occupying every shared slot.",
    unit: "jobs per kind",
    defaultValue: 1,
    min: 1,
  },
];

export function limitDefinition(key) {
  return LIMIT_DEFINITIONS.find((d) => d.key === key);
}

/** Parses a stored value against its definition, falling back to the
 *  definition's default on anything missing, non-numeric, or below the
 *  definition's minimum — a corrupted or absent row must never leave a
 *  limit at 0 (blocking everything) or negative (meaningless). */
export function parseLimitValue(
  raw,
  def
) {
  const n = raw != null ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= def.min ? n : def.defaultValue;
}
