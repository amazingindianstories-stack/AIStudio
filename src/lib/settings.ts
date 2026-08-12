/**
 * Client-safe constants for the generic admin-editable `settings` table (see
 * schema.ts) — kept separate from settings-db.ts the same way pricing.ts is
 * kept separate from pricing-db.ts, so this can be imported from "use client"
 * components without pulling in server-only DB code.
 */

export const MAX_PROMPT_LENGTH_KEY = "maxPromptLength";

// High enough that no prompt in real use today (including the longest
// shot-spec video prompts, which can reach ~18-21KB per CLAUDE.md) is
// retroactively blocked the moment this feature ships — an admin can lower
// it from the dashboard whenever they want.
export const DEFAULT_MAX_PROMPT_LENGTH = 30000;

export function parseMaxPromptLength(raw: string | undefined | null): number {
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_PROMPT_LENGTH;
}
