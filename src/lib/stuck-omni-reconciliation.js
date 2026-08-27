import { and, asc, eq, ilike, isNotNull, lt } from "drizzle-orm";

import { generations } from "@/lib/schema";

export const DEFAULT_OMNI_RECONCILE_MIN_AGE_MINUTES = 45;
export const DEFAULT_OMNI_RECONCILE_MAX_ROWS = 50;

function boundedPositiveInt(raw, fallback, max, name) {
  if (raw == null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}.`);
  }
  return value;
}

export function parseOmniReconcileArgs(args) {
  const known = new Set(["--apply", "--help"]);
  const minAgeArg = args.find((arg) => arg.startsWith("--min-age-minutes="));
  const maxRowsArg = args.find((arg) => arg.startsWith("--max-rows="));
  for (const arg of args) {
    if (known.has(arg) || arg === minAgeArg || arg === maxRowsArg) continue;
    throw new Error(`Unknown option: ${arg}`);
  }
  return {
    apply: args.includes("--apply"),
    help: args.includes("--help"),
    minAgeMinutes: boundedPositiveInt(
      minAgeArg?.slice("--min-age-minutes=".length),
      DEFAULT_OMNI_RECONCILE_MIN_AGE_MINUTES,
      10_080,
      "--min-age-minutes"
    ),
    maxRows: boundedPositiveInt(
      maxRowsArg?.slice("--max-rows=".length),
      DEFAULT_OMNI_RECONCILE_MAX_ROWS,
      500,
      "--max-rows"
    ),
  };
}

/** Dry-run candidate discovery. This does not contact the provider. */
export async function selectStaleRunningOmniRows(
  db,
  { now = Date.now(), minAgeMinutes, maxRows }
) {
  const cutoff = now - minAgeMinutes * 60_000;
  return db
    .select({
      id: generations.id,
      taskId: generations.taskId,
      model: generations.model,
      createdAt: generations.createdAt,
      updatedAt: generations.updatedAt,
    })
    .from(generations)
    .where(
      and(
        eq(generations.kind, "video"),
        eq(generations.status, "running"),
        ilike(generations.model, "%omni%"),
        isNotNull(generations.taskId),
        lt(generations.updatedAt, cutoff)
      )
    )
    .orderBy(asc(generations.updatedAt), asc(generations.id))
    .limit(maxRows);
}

/** Compare-and-set terminal state so a newer poll/operator action wins. */
export async function finalizeRunningOmniRow(db, { id, taskId, values }) {
  const rows = await db
    .update(generations)
    .set(values)
    .where(
      and(
        eq(generations.id, id),
        eq(generations.status, "running"),
        eq(generations.taskId, taskId)
      )
    )
    .returning({ id: generations.id });
  return rows.length === 1;
}

export function classifyOmniReconciliationResult(result) {
  if (result?.status === "failed") return "failed";
  if (result?.status === "succeeded" && result.videoBase64) return "succeeded";
  return "pending";
}
