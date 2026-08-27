import { and, desc, eq, sql, } from "drizzle-orm";
import { getDb } from "./db";
import { generations } from "./schema";
import { decodeCursor, encodeCursor, likePattern, } from "./store-db";
import { costBasisForGeneration } from "./cost-basis";

/**
 * The admin generation log: filtered and paginated in Postgres.
 *
 * Previously the dashboard received the newest 500 rows and did all filtering,
 * searching and model-listing in the browser. That is the same defect the
 * library feed had before 2026-07-29 — a window mistaken for a dataset — and it
 * produced the same symptoms: search that only matched loaded rows, a model
 * dropdown missing older models, and a row count that had been pinned at 500
 * since the table crossed 500.
 *
 * It also dominated the payload. Prompts here average 3.8 kB and reach 21 kB
 * (shot-by-shot video prompts), so 500 full rows measured 2,144 kB of which
 * 2,044 kB — 95% — was prompt text nobody could read in a table cell. The list
 * query therefore truncates with `left()` **in SQL**, so the bulk never leaves
 * the database. Truncation is exactly why search has to be server-side: matching
 * a truncated prompt in the browser would quietly only search its first
 * PROMPT_PREVIEW_CHARS characters.
 */

/** How much prompt the table view gets. The cell truncates visually well before
 *  this; the margin is so filtering feels honest when a row is expanded. */
export const PROMPT_PREVIEW_CHARS = 300;

/** Ceiling on one page, so a hand-edited querystring can't ask for the table. */
export const MAX_LOG_PAGE = 200;

/** Row ceiling for a CSV export. Generous enough to cover the whole table today
 *  while still bounding one request's work and memory. */
export const MAX_CSV_ROWS = 20000;

export const MAX_LOG_QUERY_LENGTH = 200;

/** Statuses a row may legitimately carry. Validated rather than passed through
 *  so the filter can't become an arbitrary string in a query. */
const STATUSES = new Set(["queued", "running", "succeeded", "failed"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse the log filter off a querystring. Unrecognised values are dropped
 *  rather than rejected, so a stale bookmark degrades to a wider view instead of
 *  erroring. */
export function parseAdminLogFilter(params) {
  const filter = {};

  const userId = params.get("userId");
  if (userId && UUID_RE.test(userId)) filter.userId = userId;

  const kind = params.get("kind");
  if (kind === "image" || kind === "video") filter.kind = kind;

  const model = params.get("model");
  if (model) filter.model = model;

  const status = params.get("status");
  if (status && STATUSES.has(status)) filter.status = status;

  const q = params.get("q")?.trim();
  if (q) filter.q = q.slice(0, MAX_LOG_QUERY_LENGTH);

  return filter;
}

/** Filter → querystring, the client half of the same contract. Kept beside the
 *  parser for the reason history-query.ts gives: the rows and the count beside
 *  them must agree on what the filter means. */
export function adminLogFilterToParams(filter) {
  const params = new URLSearchParams();
  if (filter.userId) params.set("userId", filter.userId);
  if (filter.kind) params.set("kind", filter.kind);
  if (filter.model) params.set("model", filter.model);
  if (filter.status) params.set("status", filter.status);
  if (filter.q) params.set("q", filter.q);
  return params;
}

function conditions(filter) {
  const conds = [];
  if (filter.userId) conds.push(eq(generations.userId, filter.userId));
  if (filter.kind) conds.push(eq(generations.kind, filter.kind));
  if (filter.model) conds.push(eq(generations.model, filter.model));
  if (filter.status) conds.push(eq(generations.status, filter.status));
  const q = filter.q?.trim();
  if (q) conds.push(sql`${generations.prompt} ilike ${likePattern(q)}`);
  return conds;
}

/** Column list for the table view: prompt truncated in SQL, plus a flag derived
 *  from the untruncated length so the client never has to guess. */
const previewColumns = {
  id: generations.id,
  kind: generations.kind,
  model: generations.model,
  status: generations.status,
  costCents: generations.costCents,
  costBasis: generations.costBasis,
  userId: generations.userId,
  prompt: sql`left(${generations.prompt}, ${PROMPT_PREVIEW_CHARS})`,
  promptTruncated: sql`length(${generations.prompt}) > ${PROMPT_PREVIEW_CHARS}`,
  createdAt: generations.createdAt,
};

export async function queryAdminLogs(
  filter = {},
  cursor,
  limitN = 100
) {
  const db = await getDb();
  const limit = Math.min(Math.max(limitN, 1), MAX_LOG_PAGE);
  const conds = conditions(filter);

  // Same row-value keyset as the library feed, and for the same reason:
  // created_at is a ms bigint and batch generation writes several rows inside
  // one millisecond, so a cursor on created_at alone skips or repeats rows at a
  // page boundary. Reuses generations_created_keyset_idx.
  const pageConds = [...conds];
  if (cursor) {
    pageConds.push(
      sql`(${generations.createdAt}, ${generations.id}) < (${cursor.sort}::bigint, ${cursor.id}::uuid)`
    );
  }

  const [rows, [totals]] = await Promise.all([
    db
      .select(previewColumns)
      .from(generations)
      .where(pageConds.length ? and(...pageConds) : undefined)
      .orderBy(desc(generations.createdAt), desc(generations.id))
      // One extra row is what tells us whether a next page exists, without a
      // second count query per page.
      .limit(limit + 1),
    db
      .select({
        count: sql`count(*)::int`,
        // Succeeded-only, same rule as the Overview tile (admin-stats.ts) —
        // so a filtered view (e.g. status=failed) honestly totals $0 rather
        // than disagreeing with Overview about what "spend" means.
        cost: sql`coalesce(sum(case when ${generations.status} = 'succeeded' then ${generations.costCents} else 0 end), 0)::int`,
        reconciledCost: sql`coalesce(sum(case when ${generations.status} = 'succeeded' and ${generations.costBasis} = 'reconciled' then ${generations.costCents} else 0 end), 0)::int`,
        estimatedCost: sql`coalesce(sum(case when ${generations.status} = 'succeeded' and ${generations.costBasis} <> 'reconciled' then ${generations.costCents} else 0 end), 0)::int`,
      })
      .from(generations)
      .where(conds.length ? and(...conds) : undefined),
  ]);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return {
    rows: page.map((r) => ({
      id: r.id,
      kind: r.kind,
      model: r.model,
      status: r.status,
      costCents: r.costCents ?? 0,
      costBasis: costBasisForGeneration(r),
      userId: r.userId ?? null,
      prompt: r.prompt,
      promptTruncated: r.promptTruncated,
      createdAt: r.createdAt,
    })),
    total: totals?.count ?? 0,
    totalCostCents: totals?.cost ?? 0,
    reconciledCostCents: totals?.reconciledCost ?? 0,
    estimatedCostCents: totals?.estimatedCost ?? 0,
    nextCursor: hasMore && last ? encodeCursor({ sort: last.createdAt, id: last.id }) : null,
  };
}

/** Every row matching the filter, with full prompts, for a CSV export. Bounded
 *  by MAX_CSV_ROWS. */
export async function readAdminLogsForExport(
  filter = {}
) {
  const db = await getDb();
  const conds = conditions(filter);
  const rows = await db
    .select({
      id: generations.id,
      kind: generations.kind,
      model: generations.model,
      status: generations.status,
      costCents: generations.costCents,
      costBasis: generations.costBasis,
      userId: generations.userId,
      prompt: generations.prompt,
      createdAt: generations.createdAt,
    })
    .from(generations)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(generations.createdAt), desc(generations.id))
    .limit(MAX_CSV_ROWS);
  return rows.map((r) => ({
    ...r,
    costCents: r.costCents ?? 0,
    costBasis: costBasisForGeneration(r),
    userId: r.userId ?? null,
  }));
}

export { decodeCursor };
