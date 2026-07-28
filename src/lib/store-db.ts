import { eq, desc, lt, or, gt, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { generations } from "./schema";
import type { GenerationItem } from "./types";

/**
 * Generation persistence — Postgres `generations` table (was history.json).
 * This table doubles as the generation log for the admin dashboard.
 */

type Row = typeof generations.$inferSelect;

function rowToItem(r: Row): GenerationItem {
  return {
    id: r.id,
    kind: r.kind as GenerationItem["kind"],
    status: r.status as GenerationItem["status"],
    prompt: r.prompt,
    model: r.model,
    aspectRatio: r.aspectRatio,
    resolution: r.resolution ?? undefined,
    duration: r.duration ?? undefined,
    url: r.url ?? undefined,
    poster: r.poster ?? undefined,
    referenceImages: r.referenceImages ?? undefined,
    error: r.error ?? undefined,
    moderationBlocked: r.moderationBlocked ?? undefined,
    taskId: r.taskId ?? undefined,
    projectId: r.projectId ?? undefined,
    folderId: r.folderId ?? undefined,
    userId: r.userId ?? undefined,
    costCents: r.costCents ?? undefined,
    isFavorite: r.isFavorite,
    favoritedAt: r.favoritedAt ?? undefined,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function itemToValues(item: GenerationItem): typeof generations.$inferInsert {
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
    projectId: item.projectId ?? null,
    folderId: item.folderId ?? null,
    userId: item.userId ?? null,
    costCents: item.costCents ?? 0,
    isFavorite: item.isFavorite ?? false,
    favoritedAt: item.favoritedAt ?? null,
    taskId: item.taskId ?? null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export async function readHistory(
  cursor?: number,
  limitN = 20
): Promise<GenerationItem[]> {
  const db = await getDb();
  let query: any = db.select().from(generations);
  if (cursor) {
    query = query.where(lt(generations.createdAt, cursor));
  }
  const rows = await query.orderBy(desc(generations.createdAt)).limit(limitN);
  return rows.map(rowToItem);
}

export async function upsertItem(item: GenerationItem): Promise<void> {
  const db = await getDb();
  const values = itemToValues(item);
  await db
    .insert(generations)
    .values(values)
    .onConflictDoUpdate({ target: generations.id, set: values });
}

export async function getItem(id: string): Promise<GenerationItem | undefined> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(generations)
    .where(eq(generations.id, id))
    .limit(1);
  return rows[0] ? rowToItem(rows[0]) : undefined;
}

export async function deleteItem(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(generations).where(eq(generations.id, id));
}

/** Move one item into a folder (or unsort it with folderId = undefined). */
export async function setItemFolder(
  id: string,
  projectId: string | undefined,
  folderId: string | undefined
): Promise<GenerationItem | undefined> {
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
  id: string,
  isFavorite: boolean
): Promise<GenerationItem | undefined> {
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
export async function clearFolderRefs(folderId: string): Promise<void> {
  const db = await getDb();
  await db
    .update(generations)
    .set({ folderId: null })
    .where(eq(generations.folderId, folderId));
}

/** Orphan every item in a project back to global history (project deleted). */
export async function clearProjectRefs(projectId: string): Promise<void> {
  const db = await getDb();
  await db
    .update(generations)
    .set({ projectId: null, folderId: null })
    .where(eq(generations.projectId, projectId));
}

// ---- QUEUE HELPERS ----

import { and, sql } from "drizzle-orm";
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
const MAX_CONCURRENT: Record<string, number> = { image: 2, video: 2 };

// Image jobs execute synchronously inside one serverless invocation
// (/api/queue/execute). If the platform hard-kills that invocation mid-flight
// (timeout, crash, cold-start OOM), nothing ever runs to flip the row off
// "running" — it then permanently occupies one of only MAX_CONCURRENT.image
// slots and blocks every job queued behind it forever. Video doesn't need
// this: its own status route already self-heals via POLL_TIMEOUT_MS. Mirror
// that pattern here. Swept on every status poll so any active client
// self-heals the whole queue, not just its own job.
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

async function reapStaleRunningImages(): Promise<void> {
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
        eq(generations.kind, "image"),
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
  kind: string,
  createdAt: number,
  bestOf: number,
  windowStart: number
): Promise<{
  running: number;
  older: number;
  windowCents: number;
  windowRows: number;
  oldestUpdatedAt: number | null;
}> {
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
  const row: any = (res as any).rows ? (res as any).rows[0] : (res as any)[0];
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

export interface QueueStatus {
  position: number;
  status: string;
  item?: GenerationItem;
  /** True when concurrency would allow this job but the spend budget will not.
   *  The job is healthy and will start on its own — this is not an error. */
  heldForBudget?: boolean;
  /** Why it is held, safe to show verbatim. */
  heldReason?: string;
  /** Hint for the client's next poll, in ms. */
  retryAfterMs?: number;
}

export async function getQueuePosition(id: string): Promise<QueueStatus | null> {
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

export async function lockJob(id: string): Promise<boolean> {
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
  since: number,
  limitN = 100
): Promise<GenerationItem[]> {
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
