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
      "Maximum total running image and video jobs per user. The global image/video caps still apply, so this prevents one user from occupying every shared slot.",
    unit: "image/video jobs",
    defaultValue: 8,
    min: 1,
    max: 8,
  },
  {
    key: "seedanceConcurrency",
    label: "Seedance tasks per model",
    description:
      "How many video jobs run at once on each Seedance model (2.5, 2.0, 2.0 Mini) across everyone. Match the BytePlus account: 3 for an Individual account, 10 for Enterprise. Extra jobs wait in Veevee's queue in arrival order and show that they are waiting for a free slot.",
    unit: "running tasks per model",
    defaultValue: 3,
    min: 1,
    max: 50,
    // An account-wide provider limit: set globally, never per user.
    globalOnly: true,
  },
  {
    key: "mcpDailyCapCents",
    label: "Agent daily cap",
    description:
      "The most a user's AI agents may spend in any 24 hours, in cents (2000 is $20.00). It covers MCP tokens and connected apps and the Agents tab, including the model's token cost. Each token or app also has its own lower limit, chosen when it is created.",
    unit: "cents per 24 hours",
    defaultValue: 2000,
    min: 1,
    max: 100000,
  },
  {
    key: "mcpActiveJobs",
    label: "Agent active jobs",
    description:
      "How many queued or running jobs a user's AI agents may have at once. They also count toward Max concurrent jobs.",
    unit: "agent jobs",
    defaultValue: 4,
    min: 1,
    max: 8,
  },
  {
    key: "boardAiMonthlyCapCents",
    label: "Board AI monthly limit",
    description:
      "The most a user may spend on board AI (Sidekicks, Flows, Catch up, AI search and Create with AI) in a calendar month (UTC), in cents (500 is $5.00). The default is the maximum, which means no limit until you set one.",
    unit: "cents per month",
    defaultValue: 10000000,
    min: 1,
    max: 10000000,
  },
  {
    key: "boardAiEnabled",
    label: "Board AI switch",
    description:
      "Turns all board AI (Sidekicks, Flows and Create with AI) on boards on (1) or off (0). Off blocks new board AI jobs for everyone, or for one user when set on that user. Jobs already running finish.",
    unit: "1 on, 0 off",
    switch: true,
    defaultValue: 1,
    min: 0,
    max: 1,
  },
  {
    key: "agentsEnabled",
    label: "Agents tab switch",
    description:
      "Turns the Agents tab on (1) or off (0). Unset, it is on for admins only. A global 1 turns it on for everyone unless a user is set to 0. A global 0 is the kill switch: it turns the Agents tab off for everyone, admins and per-user overrides included, and running agents pause at their next step.",
    unit: "1 on, 0 off",
    switch: true,
    note: "Agents kill switch: set 0 to stop the Agents tab for everyone at once.",
    // No global row is its own state, admins only, which neither 1 nor 0 says:
    // the Limits tab shows it blank and can delete the row again.
    unsetLabel: "Unset: admins only",
    defaultValue: 0,
    min: 0,
    max: 1,
  },
  {
    key: "agentActiveRuns",
    label: "Agent active runs",
    description:
      "How many agent runs a user may have queued, running or waiting at once.",
    unit: "runs",
    defaultValue: 2,
    min: 1,
    max: 8,
  },
  {
    key: "agentMaxStepsPerRun",
    label: "Agent steps per run",
    description:
      "The most model and tool steps one agent run may take. Past it the run pauses, and a second refusal ends it.",
    unit: "steps",
    defaultValue: 40,
    min: 1,
    max: 200,
  },
  {
    key: "agentMaxRunCostCents",
    label: "Agent cost per run",
    description:
      "The most one agent run may spend on paid tools and model tokens, in cents (1000 is $10.00).",
    unit: "cents per run",
    defaultValue: 1000,
    min: 1,
    max: 100000,
  },
  {
    key: "agentGlobalDailyCapCents",
    label: "Agent global daily cap",
    description:
      "The most all users' agents together may spend in any 24 hours, in cents (20000 is $200.00), on tools and model tokens. Set globally, never per user.",
    unit: "cents per 24 hours",
    defaultValue: 20000,
    min: 1,
    max: 10000000,
    globalOnly: true,
  },
  {
    key: "agentMaxConcurrentRuns",
    label: "Agent concurrent runs",
    description:
      "How many agent runs may run at once across everyone. Set globally, never per user.",
    unit: "running runs",
    defaultValue: 8,
    min: 1,
    max: 50,
    globalOnly: true,
  },
  {
    key: "agentAttachMaxMb",
    label: "Agent attachment size",
    description:
      "The largest file a user may attach to an agent chat.",
    unit: "MB",
    defaultValue: 20,
    min: 1,
    max: 100,
  },
  {
    key: "agentAttachMaxVideoSeconds",
    label: "Agent video attachment length",
    description:
      "The longest video a user may attach to an agent chat.",
    unit: "seconds",
    defaultValue: 300,
    min: 1,
    max: 3600,
  },
  {
    key: "agentAttachMaxAudioSeconds",
    label: "Agent audio attachment length",
    description:
      "The longest audio clip or voice note a user may attach to an agent chat.",
    unit: "seconds",
    defaultValue: 600,
    min: 1,
    max: 7200,
  },
  {
    key: "agentAttachImages",
    label: "Agent image attachments",
    description:
      "Allows (1) or blocks (0) images attached to an agent chat, for everyone or for one user when set on that user.",
    unit: "1 on, 0 off",
    switch: true,
    defaultValue: 1,
    min: 0,
    max: 1,
  },
  {
    key: "agentAttachDocuments",
    label: "Agent document attachments",
    description:
      "Allows (1) or blocks (0) documents attached to an agent chat, for everyone or for one user when set on that user.",
    unit: "1 on, 0 off",
    switch: true,
    defaultValue: 1,
    min: 0,
    max: 1,
  },
  {
    key: "agentAttachVideo",
    label: "Agent video attachments",
    description:
      "Allows (1) or blocks (0) videos attached to an agent chat, for everyone or for one user when set on that user.",
    unit: "1 on, 0 off",
    switch: true,
    defaultValue: 1,
    min: 0,
    max: 1,
  },
  {
    key: "agentAttachAudio",
    label: "Agent audio attachments",
    description:
      "Allows (1) or blocks (0) audio files attached to an agent chat, for everyone or for one user when set on that user.",
    unit: "1 on, 0 off",
    switch: true,
    defaultValue: 1,
    min: 0,
    max: 1,
  },
];

/** Limits an administrator may override for one user. */
export const USER_LIMIT_DEFINITIONS = LIMIT_DEFINITIONS.filter((d) => !d.globalOnly);

export function limitDefinition(key) {
  return LIMIT_DEFINITIONS.find((d) => d.key === key);
}

/** Shared server/UI validation for an administrator-provided limit. */
export function isLimitValueAllowed(value, def) {
  return Number.isFinite(value) && value >= def.min && (def.max == null || value <= def.max);
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
  if (!Number.isFinite(n) || n < def.min) return def.defaultValue;
  return def.max == null ? n : Math.min(n, def.max);
}
