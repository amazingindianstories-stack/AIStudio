import { eq, desc, lt, or, gt, inArray, isNull, and, sql, } from "drizzle-orm";
import { getDb } from "./db";
import { generations } from "./schema";

/**
 * Generation persistence — Postgres `generations` table (was history.json).
 * This table doubles as the generation log for the admin dashboard.
 */

function rowToItem(r) {
  return {
    id: r.id,
    kind: r.kind ,
    status: r.status ,
    prompt: r.prompt,
    model: r.model,
    aspectRatio: r.aspectRatio,
    resolution: r.resolution ?? undefined,
    duration: r.duration ?? undefined,
    url: r.url ?? undefined,
    poster: r.poster ?? undefined,
    referenceImages: r.referenceImages ?? undefined,
    referenceVideos: r.referenceVideos ?? undefined,
    error: r.error ?? undefined,
    moderationBlocked: r.moderationBlocked ?? undefined,
    taskId: r.taskId ?? undefined,
    generateAudio: r.generateAudio ?? undefined,
    videoTaskMode: (r.videoTaskMode ) ?? undefined,
    progressPercent: r.progressPercent ?? undefined,
    progressMessage: r.progressMessage ?? undefined,
    trackCharacters: r.trackCharacters ?? undefined,
    projectId: r.projectId ?? undefined,
    folderId: r.folderId ?? undefined,
    userId: r.userId ?? undefined,
    costCents: r.costCents ?? undefined,
    seed: r.seed ?? undefined,
    candidateTaskIds: r.candidateTaskIds ?? undefined,
    isFavorite: r.isFavorite,
    favoritedAt: r.favoritedAt ?? undefined,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function itemToValues(item) {
  return {
    id: item.id,
    kind: item.kind,
    status: item.status,
    prompt: item.prompt,
    model: item.model,
    aspectRatio: item.aspectRatio,
    resolution: item.resolution ?? null,
    duration: item.duration ?? null,
    url: item.url ?? null,
    poster: item.poster ?? null,
    error: item.error ?? null,
    moderationBlocked: item.moderationBlocked ?? null,
    referenceImages: item.referenceImages ?? null,
    referenceVideos: item.referenceVideos ?? null,
    projectId: item.projectId ?? null,
    folderId: item.folderId ?? null,
    userId: item.userId ?? null,
    costCents: item.costCents ?? 0,
    seed: item.seed ?? null,
    candidateTaskIds: item.candidateTaskIds ?? null,
    isFavorite: item.isFavorite ?? false,
    favoritedAt: item.favoritedAt ?? null,
    taskId: item.taskId ?? null,
    generateAudio: item.generateAudio ?? null,
    videoTaskMode: item.videoTaskMode ?? null,
    progressPercent: item.progressPercent ?? null,
    progressMessage: item.progressMessage ?? null,
    trackCharacters: item.trackCharacters ?? null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

// ── library feed: scoped, keyset-paginated reads ────────────────────────────
//
// Every asset view in the app (All assets, a project, a folder, Favourites) is
// a filter over this one table, and each used to be produced by pulling global
// history 20 rows at a time and filtering it in the browser. That made the cost
// of opening a view proportional to how OLD it was: a project last touched a
// year ago needed the client to page through every unrelated generation made
// since before its first item appeared, and until then it rendered as empty
// with zero counts. The filters below move that work to Postgres, where the
// indexes declared in schema.ts turn it into a bounded index range scan — page
// one of an old project now costs the same as page one of today's.
//
// Pagination is a row-value keyset, NOT an offset. Offsets re-scan and skip
// every preceding row (so page 40 is 40× the work of page 1) and they shift
// under concurrent inserts, which this table gets constantly — a generation
// finishing mid-scroll would silently duplicate or drop a row at the boundary.
// A keyset is stable under inserts and costs the same at every depth.

export function encodeCursor(c) {
  return `${c.sort}.${c.id}`;
}

/** Parse a client-supplied cursor. Returns undefined for anything malformed so
 *  a junk querystring degrades to "first page" instead of an error or, worse,
 *  a predicate built from NaN that silently matches nothing. */
export function decodeCursor(raw) {
  if (!raw) return undefined;
  const dot = raw.indexOf(".");
  if (dot <= 0) return undefined;
  const sort = Number(raw.slice(0, dot));
  const id = raw.slice(dot + 1);
  // The id half goes into a ::uuid cast — reject anything that isn't one
  // rather than letting Postgres raise on the cast.
  if (!Number.isFinite(sort)) return undefined;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return undefined;
  }
  return { sort, id };
}

/** LIKE metacharacters in user input are literals, not wildcards. Postgres's
 *  default LIKE escape is backslash, so escape it and the two wildcards.
 *  Exported because the admin log search runs the same ILIKE against the same
 *  column — a second copy of this would be a second chance to get it wrong. */
export function likePattern(q) {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/** The WHERE fragments shared by the page query and the count queries — one
 *  definition so a filter can never mean two different things in the grid and
 *  in the number next to it. */
function filterConditions(filter) {
  const conds = [];
  if (filter.projectId) conds.push(eq(generations.projectId, filter.projectId));
  if (filter.folderId === null) conds.push(isNull(generations.folderId));
  else if (filter.folderId) conds.push(eq(generations.folderId, filter.folderId));
  if (filter.kind) conds.push(eq(generations.kind, filter.kind));
  if (filter.favorite) conds.push(eq(generations.isFavorite, true));
  const q = filter.q?.trim();
  if (q) conds.push(sql`${generations.prompt} ilike ${likePattern(q)}`);
  return conds;
}

export async function queryHistory(
  filter = {},
  cursor,
  limitN = 20
) {
  const db = await getDb();
  // Favourites are ordered by when they were starred; everything else by when
  // it was made. `favorited_at` is backfilled non-null for favourited rows
  // (scripts/optimize-history-indexes.ts) precisely so this column can carry
  // the keyset — a NULL here would fall outside the row comparison below and
  // strand those rows on a page boundary forever.
  const sortCol = filter.favorite ? generations.favoritedAt : generations.createdAt;

  const conds = filterConditions(filter);
  if (cursor) {
    // Row-value comparison: strictly "after" this position in the composite
    // ordering. Written as one `(a,b) < (c,d)` rather than the expanded
    // `a < c OR (a = c AND b < d)` because only the row-value form is
    // recognised as an index range bound.
    conds.push(
      sql`(${sortCol}, ${generations.id}) < (${cursor.sort}::bigint, ${cursor.id}::uuid)`
    );
  }

  // Fetch one extra row: its existence is what proves there is a next page.
  // Inferring "more" from `rows.length === limit` guesses wrong exactly when
  // the total is a multiple of the page size, leaving a permanent phantom
  // "Loading more…" sentinel that never resolves.
  const rows = await db
    .select()
    .from(generations)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(sortCol), desc(generations.id))
    .limit(limitN + 1);

  const hasMore = rows.length > limitN;
  const page = hasMore ? rows.slice(0, limitN) : rows;
  const items = page.map(rowToItem);
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({
          sort: Number(filter.favorite ? last.favoritedAt ?? last.createdAt : last.createdAt),
          id: last.id,
        })
      : null;

  return { items, nextCursor };
}

/**
 * True counts for the folder rail, in one grouped query.
 *
 * These used to be `items.filter(...).length` over whatever slice of global
 * history the client happened to have paged in, which is why a project with
 * hundreds of assets rendered every folder as "0". `kind`/`q` are honoured so
 * the number beside a folder always describes what clicking it would show.
 */
export async function countHistory(
  filter = {}
) {
  const db = await getDb();
  // folderId is the grouping key here, so it must not also be a predicate.
  const { folderId: _ignored, ...rest } = filter;
  const conds = filterConditions(rest);
  const rows = await db
    .select({
      folderId: generations.folderId,
      n: sql`count(*)::int`,
    })
    .from(generations)
    .where(conds.length ? and(...conds) : undefined)
    .groupBy(generations.folderId);

  const byFolder = {};
  let total = 0;
  let unsorted = 0;
  for (const r of rows) {
    const n = Number(r.n ?? 0);
    total += n;
    if (r.folderId) byFolder[r.folderId] = n;
    else unsorted += n;
  }
  return { total, unsorted, byFolder };
}

/** Count for a scope that has no folder dimension (All assets, Favourites). */
export async function countScope(filter = {}) {
  const db = await getDb();
  const conds = filterConditions(filter);
  const rows = await db
    .select({ n: sql`count(*)::int` })
    .from(generations)
    .where(conds.length ? and(...conds) : undefined);
  return Number(rows[0]?.n ?? 0);
}

export async function upsertItem(item) {
  const db = await getDb();
  const values = itemToValues(item);
  await db
    .insert(generations)
    .values(values)
    .onConflictDoUpdate({ target: generations.id, set: values });
}

export async function getItem(id) {
  const db = await getDb();
  const rows = await db
    .select()
    .from(generations)
    .where(eq(generations.id, id))
    .limit(1);
  return rows[0] ? rowToItem(rows[0]) : undefined;
}

export async function deleteItem(id) {
  const db = await getDb();
  await db.delete(generations).where(eq(generations.id, id));
}

/** Move one item into a folder (or unsort it with folderId = undefined). */
export async function setItemFolder(
  id,
  projectId,
  folderId
) {
  const db = await getDb();
  const rows = await db
    .update(generations)
    .set({
      projectId: projectId ?? null,
      folderId: folderId ?? null,
      updatedAt: Date.now(),
    })
    .where(eq(generations.id, id))
    .returning();
  return rows[0] ? rowToItem(rows[0]) : undefined;
}

/** Star/unstar a generation for the shared Favourites view. */
export async function setItemFavorite(
  id,
  isFavorite
) {
  const db = await getDb();
  const rows = await db
    .update(generations)
    .set({
      isFavorite,
      favoritedAt: isFavorite ? Date.now() : null,
      updatedAt: Date.now(),
    })
    .where(eq(generations.id, id))
    .returning();
  return rows[0] ? rowToItem(rows[0]) : undefined;
}

/** Unsort every item in a folder (used when a folder is deleted). */
export async function clearFolderRefs(folderId) {
  const db = await getDb();
  await db
    .update(generations)
    .set({ folderId: null })
    .where(eq(generations.folderId, folderId));
}

/** Orphan every item in a project back to global history (project deleted). */
export async function clearProjectRefs(projectId) {
  const db = await getDb();
  await db
    .update(generations)
    .set({ projectId: null, folderId: null })
    .where(eq(generations.projectId, projectId));
}

// ---- QUEUE HELPERS ----

import {
  admits,
  bestOfMultiplier,
  holdRetryAfterMs,
  spendLimitCents,
  HELD_MESSAGE,
  SPEND_WINDOW_MS,
} from "./spend-window";

// Global active-request caps, per kind: images bound our own server (each
// running job is a 30–60s serverless invocation with best-of-N provider
// calls); videos bound the provider (concurrent remote renders + MCP rate
// limits). Anything beyond the cap waits in the queue.
const MAX_CONCURRENT = { image: 2, video: 2 };

// Image jobs execute synchronously inside one serverless invocation
// (/api/queue/execute). If the platform hard-kills that invocation mid-flight
// (timeout, crash, cold-start OOM), nothing ever runs to flip the row off
// "running" — it then permanently occupies one of only MAX_CONCURRENT.image
// slots and blocks every job queued behind it forever. Swept on every status
// poll so any active client self-heals the whole queue, not just its own job.
//
// Video also needs a slice of this, for one specific case: /api/queue/execute
// (shared with images, same maxDuration) locks the row "running" and only
// afterwards submits it to the provider and stamps taskId. If the invocation
// dies in between, the row is "running" with taskId still null and nothing
// can ever poll it to completion — the video status route requires a taskId
// to have anything to ask the provider about. Its own POLL_TIMEOUT_MS only
// helps if a client is actively polling that item, but `adoptOrphanedJobs`
// on the client deliberately skips "running" jobs (a running video is assumed
// to already be submitted remotely), so a taskId-less zombie with no active
// tab is invisible to every client-side self-heal path. Once taskId is set,
// leave it to the status route/self-heal above — this only catches the
// narrow pre-submission gap.
//
// This threshold MUST stay above /api/queue/execute's maxDuration (300s), or
// the reaper fails jobs that are still legitimately running — the row's
// updatedAt is stamped once by lockJob and is not touched again until the job
// finishes, so a slow-but-healthy job looks identical to a dead one until its
// invocation budget is provably spent. 300s budget + 120s slack; nothing
// legitimate is still "running" 7 minutes after lockJob stamped it.
const STALE_RUNNING_MS = 7 * 60 * 1000;

// The reaper is a blind UPDATE and every status poll used to fire one — with a
// 3s poll per in-flight job that is a lot of pointless write traffic against a
// condition that can only become true once every STALE_RUNNING_MS. Under fluid
// compute instances stay warm and serve many polls, so a per-instance clock
// collapses nearly all of it. Correctness does not depend on this: any instance
// that has never swept still sweeps on its first poll, and the sweep is
// idempotent, so the worst case is that a stranded row is noticed one interval
// late by a client whose instance happens to be cold.
const REAP_INTERVAL_MS = 30_000;
let lastReapAt = 0;

async function reapStaleRunningImages() {
  const now = Date.now();
  if (now - lastReapAt < REAP_INTERVAL_MS) return;
  lastReapAt = now;
  const db = await getDb();
  await db
    .update(generations)
    .set({
      status: "failed",
      error: "Generation timed out — the server process was interrupted.",
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(generations.status, "running"),
        or(
          eq(generations.kind, "image"),
          and(eq(generations.kind, "video"), isNull(generations.taskId))
        ),
        lt(generations.updatedAt, Date.now() - STALE_RUNNING_MS)
      )
    );
}

/**
 * Everything getQueuePosition needs about the rest of the queue, in one round
 * trip: concurrency counts plus the rolling spend window.
 *
 * This runs on every poll of every in-flight job, so it is deliberately a
 * single query with scalar subqueries rather than the three sequential
 * SELECTs it replaces.
 *
 * The spend window counts image jobs AND Omni video jobs, because Omni runs on
 * generativelanguage with the same GOOGLE_API_KEY (providers/omni.ts) and so
 * draws on the same budget. Higgsfield and BytePlus do not — different vendors,
 * different limits — and must stay excluded or the gate throttles work that
 * costs Google nothing.
 *
 * Cost weighting differs by status on purpose: /api/queue/execute multiplies
 * costCents by the number of best-of-N candidates *after* they resolve, so
 * finished rows already carry their true multi-render cost, while a running row
 * still holds the single-render price and must be scaled up to estimate what it
 * is spending right now.
 *
 * Rows that failed with a 429 are excluded: they were rejected, so they cost
 * nothing. Counting them would let one rate-limit storm suppress the queue for
 * a further 10 minutes on the strength of spend that never happened.
 */
async function queueSnapshot(
  kind,
  createdAt,
  bestOf,
  windowStart
)

 {
  const db = await getDb();
  // `created_at > windowStart - 6h` is a redundant but index-backed superset of
  // the updated_at predicate (generations_created_at_idx exists; updated_at has
  // no index and adding one would mean a migration). Safe because nothing in
  // the app touches a row more than ~30 min after creation — images are reaped
  // at 7 min, videos time out at 30 — so a 6-hour skirt cannot exclude a row
  // that genuinely belongs in a 10-minute window.
  const res = await db.execute(sql`
    select
      (select count(*) from ${generations}
        where status = 'running' and kind = ${kind}) as running,
      (select count(*) from ${generations}
        where status = 'queued' and kind = ${kind}
          and created_at < ${createdAt}) as older,
      (select coalesce(sum(
          case when status = 'running' then cost_cents * ${bestOf} else cost_cents end
        ), 0) from ${generations}
        where created_at > ${windowStart - 6 * 60 * 60 * 1000}
          and updated_at >= ${windowStart}
          and status in ('running', 'succeeded', 'failed')
          and (kind = 'image' or model ilike '%omni%')
          and not (status = 'failed' and coalesce(error, '') like '%429%')
      ) as window_cents,
      (select count(*) from ${generations}
        where created_at > ${windowStart - 6 * 60 * 60 * 1000}
          and updated_at >= ${windowStart}
          and status in ('running', 'succeeded', 'failed')
          and (kind = 'image' or model ilike '%omni%')
          and not (status = 'failed' and coalesce(error, '') like '%429%')
      ) as window_rows,
      (select min(updated_at) from ${generations}
        where created_at > ${windowStart - 6 * 60 * 60 * 1000}
          and updated_at >= ${windowStart}
          and status in ('running', 'succeeded', 'failed')
          and (kind = 'image' or model ilike '%omni%')
          and not (status = 'failed' and coalesce(error, '') like '%429%')
      ) as oldest_updated_at
  `);
  const row = (res ).rows ? (res ).rows[0] : (res )[0];
  return {
    running: Number(row.running ?? 0),
    older: Number(row.older ?? 0),
    windowCents: Number(row.window_cents ?? 0),
    windowRows: Number(row.window_rows ?? 0),
    oldestUpdatedAt:
      row.oldest_updated_at === null || row.oldest_updated_at === undefined
        ? null
        : Number(row.oldest_updated_at),
  };
}

export async function getQueuePosition(id) {
  await reapStaleRunningImages();
  const item = await getItem(id);
  if (!item) return null;
  // Include the full row once it's left the queue: a client that resumed
  // polling after a reload (job already "running"/finished server-side) has
  // no other way to learn the finished url/status without this.
  if (item.status !== "queued") return { position: 0, status: item.status, item };

  const cap = MAX_CONCURRENT[item.kind] ?? 2;
  const now = Date.now();
  const bestOf = bestOfMultiplier();
  const snap = await queueSnapshot(
    item.kind,
    item.createdAt,
    bestOf,
    now - SPEND_WINDOW_MS
  );

  const totalAhead = snap.running + snap.older;
  const position = Math.max(0, totalAhead - (cap - 1));
  if (position > 0) return { position, status: item.status };

  // Concurrency says go. Now ask whether Google's rolling spend window can
  // afford it — see lib/spend-window.ts for why holding beats retrying.
  //
  // Only jobs that actually bill Gemini are gated. A Higgsfield or BytePlus
  // video must never be held behind a Google budget it does not consume.
  const billsGemini = item.kind === "image" || /omni/i.test(item.model);
  if (!billsGemini) return { position, status: item.status };

  const limitCents = spendLimitCents();
  const jobCents = (item.costCents ?? 0) * bestOf;
  if (
    admits({
      windowCents: snap.windowCents,
      jobCents,
      limitCents,
      windowBusy: snap.windowRows > 0,
    })
  ) {
    return { position, status: item.status };
  }

  // Held: report position 1 so the existing client contract ("execute only at
  // position 0") keeps the job parked without any client change, and attach the
  // reason so the UI can say something truthful instead of implying a backlog.
  return {
    position: 1,
    status: item.status,
    heldForBudget: true,
    heldReason: HELD_MESSAGE,
    retryAfterMs: holdRetryAfterMs(snap.oldestUpdatedAt, now),
  };
}

export async function lockJob(id) {
  const db = await getDb();
  // Atomic update: only lock if still queued
  const res = await db
    .update(generations)
    .set({ status: "running", updatedAt: Date.now() })
    .where(and(eq(generations.id, id), eq(generations.status, "queued")))
    .returning({ id: generations.id });
  return res.length > 0;
}

/**
 * Generations that changed since `since`, for the client's live-update poller.
 *
 * Returns two overlapping sets in one query:
 *  - everything currently queued or running, so a client learns about jobs it
 *    did not start itself (another tab, another device, a teammate — history
 *    is team-wide, there is no per-user filter);
 *  - everything whose updatedAt has moved past the caller's watermark, which
 *    is how a completion is observed.
 *
 * The in-flight half is deliberately unconditional rather than watermarked: a
 * job that is still running has not changed since the client last looked, so a
 * pure `updatedAt > since` query would never mention it, and a client that
 * missed its creation would stay blind until it finished.
 *
 * Ordered by updatedAt so the newest changes survive the cap if one poll
 * somehow spans more than `limitN` changes.
 */
export async function readGenerationUpdates(
  since,
  limitN = 100
) {
  const db = await getDb();
  const rows = await db
    .select()
    .from(generations)
    .where(
      or(
        inArray(generations.status, ["queued", "running"]),
        gt(generations.updatedAt, since)
      )
    )
    .orderBy(desc(generations.updatedAt))
    .limit(limitN);
  return rows.map(rowToItem);
}
