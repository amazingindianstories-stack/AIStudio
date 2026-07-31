import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { getDb } from "./db";
import { activityLogs } from "./schema";
import { decodeCursor, encodeCursor, type HistoryCursor } from "./store-db";

/**
 * The admin audit trail: filtered and paginated in Postgres.
 *
 * This is the third and last list on the dashboard to stop being a window
 * mistaken for a dataset. `/api/admin/data` used to ship the newest 500 events
 * and the browser filtered them in memory, which meant the action dropdown only
 * offered actions present in those 500, an older event could not be reached at
 * all, and — once the generation log moved out on 2026-07-30 — this one list was
 * ~94% of everything that route returned.
 *
 * Unlike the generation log there was never a wrong *total* on screen (the label
 * honestly said "of the most recent 500"), so the win here is reachability and
 * payload, not correctness of a figure.
 *
 * `detail` is returned whole rather than truncated the way prompts are: every
 * writer of it stores a small object, and the one that could have been large —
 * the delete event — already slices the prompt to 120 chars at the call site.
 * If a future action logs something bulky, truncate it here in SQL rather than
 * letting the client shrink it after paying to download it.
 */

/** Rows per page. Smaller than the log's 100: an event row is short, and this
 *  list sits under the log rather than being the focus of its own tab. */
export const ACTIVITY_PAGE_SIZE = 50;

/** Ceiling on one page, so a hand-edited querystring can't ask for the table. */
export const MAX_ACTIVITY_PAGE = 200;

/** `action` is a free-text column — new actions appear whenever a call site is
 *  added — so it is length-capped rather than checked against a whitelist that
 *  would silently drop a filter for a legitimately new action. */
export const MAX_ACTION_LENGTH = 64;

export interface AdminActivityFilter {
  action?: string;
  userId?: string;
}

export interface AdminActivityRow {
  id: string;
  userId: string | null;
  action: string;
  detail: unknown;
  createdAt: number;
}

export interface AdminActivityPage {
  rows: AdminActivityRow[];
  /** Events matching the filter across the whole table, not just this page. */
  total: number;
  nextCursor: string | null;
  /** Every action ever recorded, from a SQL DISTINCT. Present on the first page
   *  only — it does not change as you page, and it is the one part of this
   *  response that has to scan beyond the page. */
  actions?: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse the activity filter off a querystring. Unrecognised values are dropped
 *  rather than rejected, so a stale bookmark degrades to a wider view instead of
 *  erroring — same contract as parseAdminLogFilter. */
export function parseAdminActivityFilter(params: URLSearchParams): AdminActivityFilter {
  const filter: AdminActivityFilter = {};

  const action = params.get("action")?.trim();
  if (action) filter.action = action.slice(0, MAX_ACTION_LENGTH);

  const userId = params.get("userId");
  if (userId && UUID_RE.test(userId)) filter.userId = userId;

  return filter;
}

/** Filter → querystring, the client half of the same contract. */
export function adminActivityFilterToParams(filter: AdminActivityFilter): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.action) params.set("action", filter.action);
  if (filter.userId) params.set("userId", filter.userId);
  return params;
}

function conditions(filter: AdminActivityFilter): SQL[] {
  const conds: SQL[] = [];
  if (filter.action) conds.push(eq(activityLogs.action, filter.action));
  if (filter.userId) conds.push(eq(activityLogs.userId, filter.userId));
  return conds;
}

/** Every distinct action, for the filter dropdown. Read from the table rather
 *  than from the loaded rows — that is what made the old dropdown miss actions
 *  whose last occurrence had scrolled past the 500-row window. */
export async function readActivityActions(): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .selectDistinct({ action: activityLogs.action })
    .from(activityLogs)
    .orderBy(activityLogs.action);
  return rows.map((r) => r.action);
}

export async function queryActivity(
  filter: AdminActivityFilter = {},
  cursor?: HistoryCursor,
  limitN: number = ACTIVITY_PAGE_SIZE
): Promise<AdminActivityPage> {
  const db = await getDb();
  const limit = Math.min(Math.max(limitN, 1), MAX_ACTIVITY_PAGE);
  const conds = conditions(filter);

  // Same row-value keyset as the feed and the generation log. It matters here
  // for the same reason: created_at is a ms bigint, and a batch generation
  // writes its rows — and their "generate" events — inside one millisecond, so a
  // cursor on created_at alone would skip or repeat rows at a page boundary.
  const pageConds = [...conds];
  if (cursor) {
    pageConds.push(
      sql`(${activityLogs.createdAt}, ${activityLogs.id}) < (${cursor.sort}::bigint, ${cursor.id}::uuid)`
    );
  }

  const [rows, [totals], actions] = await Promise.all([
    db
      .select()
      .from(activityLogs)
      .where(pageConds.length ? and(...pageConds) : undefined)
      .orderBy(desc(activityLogs.createdAt), desc(activityLogs.id))
      // The extra row is what tells us a next page exists, without a second
      // count query per page.
      .limit(limit + 1),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(activityLogs)
      .where(conds.length ? and(...conds) : undefined),
    cursor ? Promise.resolve(undefined) : readActivityActions(),
  ]);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return {
    rows: page.map((r) => ({
      id: r.id,
      userId: r.userId ?? null,
      action: r.action,
      detail: r.detail ?? null,
      createdAt: r.createdAt,
    })),
    total: totals?.count ?? 0,
    nextCursor: hasMore && last ? encodeCursor({ sort: last.createdAt, id: last.id }) : null,
    ...(actions ? { actions } : {}),
  };
}

export { decodeCursor };
