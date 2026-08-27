import { sql } from "drizzle-orm";
import { getDb } from "./db";
import { generations } from "./schema";

/**
 * Dashboard headline figures, aggregated in Postgres.
 *
 * These used to be computed in the browser from the generation log the admin
 * route shipped — which was capped at 500 rows, so every one of them silently
 * became "over the newest 500 generations" instead of "over everything". The
 * visible symptom was a Generations tile frozen at 500; the damaging one was
 * Total spend under-reporting by 41% (measured 2026-07-30: $152.74 shown
 * against $257.18 actual over 916 rows) while the Users tab — which was already
 * aggregated in SQL — disagreed with it.
 *
 * So the rule this file exists to enforce: a total is a `count(*)`/`sum()`, never
 * the length of an array that arrived over the wire. It is also what makes the
 * payload small, since none of these need a single row shipped to the client.
 */

/** Window for the activity chart. Bounded so the payload can't grow without
 *  limit as the table does; the old chart's span was an accident of how many
 *  days the newest 500 rows happened to cover. */
const OVER_TIME_DAYS = 90;

/**
 * `created_at` is a millisecond bigint, not a timestamptz. Bucket in UTC
 * explicitly: the previous client-side version used
 * `new Date(ms).toISOString().slice(0, 10)`, so UTC keeps the chart's buckets
 * identical rather than shifting every point by the server's offset.
 */
const DAY_EXPR = sql`to_char(to_timestamp(${generations.createdAt} / 1000.0) at time zone 'utc', 'YYYY-MM-DD')`;

export async function readAdminStats() {
  const db = await getDb();
  const since = Date.now() - OVER_TIME_DAYS * 24 * 60 * 60 * 1000;

  const [totalRows, kindRows, modelRows, dayRows] = await Promise.all([
    db
      .select({
        // Unconditional — "Generations" means every attempt, same as before.
        count: sql`count(*)::int`,
        // Conditional on the row's OWN status: costCents is written at
        // enqueue time as an estimate, before the provider is ever called,
        // and is never zeroed on failure (see readEffectiveMaxPromptLength's
        // sibling note in generate/image and generate/video — same file
        // family, same reasoning). Summing it unconditionally counted
        // queued-and-never-run and failed-before-any-provider-cost rows as
        // "spend" that was never actually incurred. Matches the precedent
        // already in spend-window.ts, which excludes 429-rejected rows from
        // the Gemini admission-control window for the identical reason
        // ("they were rejected, so they cost nothing"). The one provider
        // that reports real billing (Kling) only overwrites costCents on
        // the succeeded path anyway, so this doesn't change anything for
        // rows where we already know the truth — it only stops treating an
        // estimate on a row that never became real as if it had.
        cost: sql`coalesce(sum(case when ${generations.status} = 'succeeded' then ${generations.costCents} else 0 end), 0)::int`,
        reconciledCost: sql`coalesce(sum(case when ${generations.status} = 'succeeded' and ${generations.costBasis} = 'reconciled' then ${generations.costCents} else 0 end), 0)::int`,
        estimatedCost: sql`coalesce(sum(case when ${generations.status} = 'succeeded' and ${generations.costBasis} <> 'reconciled' then ${generations.costCents} else 0 end), 0)::int`,
      })
      .from(generations),
    db
      .select({
        name: generations.kind,
        value: sql`count(*)::int`,
      })
      .from(generations)
      .groupBy(generations.kind),
    db
      .select({
        name: generations.model,
        value: sql`count(*)::int`,
      })
      .from(generations)
      .groupBy(generations.model)
      .orderBy(sql`count(*) desc`),
    db
      .select({ day: DAY_EXPR, count: sql`count(*)::int` })
      .from(generations)
      .where(sql`${generations.createdAt} >= ${since}`)
      .groupBy(DAY_EXPR)
      .orderBy(sql`1 asc`),
  ]);

  const total = totalRows[0] ?? { count: 0, cost: 0, reconciledCost: 0, estimatedCost: 0 };
  const byKindMap = new Map(kindRows.map((r) => [r.name, r.value]));

  return {
    totalGenerations: total.count,
    totalCostCents: total.cost,
    reconciledCostCents: total.reconciledCost,
    estimatedCostCents: total.estimatedCost,
    // Fixed order with explicit zeros, so the pie chart doesn't reorder its
    // slices (and recolour them) as the mix shifts.
    byKind: (["image", "video"] ).map((name) => ({
      name,
      value: byKindMap.get(name) ?? 0,
    })),
    byModel: modelRows.map((r) => ({ name: r.name, value: r.value })),
    overTime: dayRows.map((r) => ({ day: r.day, count: r.count })),
    models: modelRows.map((r) => r.name),
  };
}
