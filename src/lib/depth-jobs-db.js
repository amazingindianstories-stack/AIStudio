import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "./db";
import { generations, depthWorkers } from "./schema";

/**
 * Data access for the local depth-map worker subsystem (kind='depth' rows in
 * `generations`, plus the `depth_workers` registry). See schema.js for the
 * shape and CLAUDE.md's "Depth-map worker" section for the end-to-end flow.
 */

/** A worker is considered online if it has heartbeated within this window.
 *  The worker heartbeats every ~15s (see depth-worker/worker.py); 45s gives
 *  two missed beats of slack for a slow tick before the pill flips to
 *  offline, so a single delayed network write doesn't flap the UI. */
export const WORKER_STALE_MS = 45_000;
export const DEPTH_WORKER_PROTOCOL_VERSION = 2;
export const MAX_DEPTH_REAP_ATTEMPTS = 3;
export const DEPTH_CLAIM_GRACE_MS = 60_000;
const REAP_INTERVAL_MS = 30_000;
let lastDepthReapAt = 0;

function claimCondition(jobId, claimId) {
  return and(
    eq(generations.id, jobId),
    eq(generations.status, "running"),
    claimId ? eq(generations.depthClaimId, claimId) : isNull(generations.depthClaimId)
  );
}

/**
 * Atomically claim the oldest queued depth job for this worker.
 *
 * `FOR UPDATE SKIP LOCKED` (rather than a separate SELECT-then-UPDATE, which
 * is what lockJob in store-db.js uses for a *known* id) is what makes this
 * safe with more than one worker: two concurrent claims cannot both win the
 * same row, and a claim never blocks behind another in-flight claim the way
 * a plain `FOR UPDATE` would. Only one worker exists today, but a queue this
 * app's own operator described as needing "a load balancer" should not need
 * a rewrite the day a second machine joins.
 */
export async function claimNextDepthJob(workerId, { protocolVersion = 1 } = {}) {
  const db = await getDb();
  const now = Date.now();
  const claimId = protocolVersion >= DEPTH_WORKER_PROTOCOL_VERSION ? randomUUID() : null;
  const res = await db.execute(sql`
    update ${generations}
    set status = 'running', updated_at = ${now}, progress_percent = 0,
        progress_message = 'Claimed by worker', depth_claim_id = ${claimId},
        depth_claim_worker_id = ${workerId}
    where id = (
      select id from ${generations}
      where kind = 'depth' and status = 'queued'
      order by created_at asc
      limit 1
      for update skip locked
    )
    returning *
  `);
  const rows = res.rows ?? res;
  if (!rows?.length) return null;
  const r = rows[0];
  return {
    id: r.id,
    claimId: r.depth_claim_id ?? undefined,
    prompt: r.prompt,
    model: r.model,
    // The encoder choice (vits/vitb/vitl) rides in `resolution` — see the
    // comment on the /api/worker/depth/claim route that reads this.
    encoder: r.resolution ?? undefined,
    trackCharacters: r.track_characters ?? false,
    referenceVideos: r.reference_videos ?? undefined,
    userId: r.user_id ?? undefined,
    createdAt: Number(r.created_at),
  };
}

/**
 * Update progress on a job this worker currently holds. Scoped to
 * status='running' so a stray or late-arriving progress ping from a job that
 * has already completed (or, in a multi-worker future, been reassigned)
 * can't resurrect stale data on a finished row.
 */
export async function reportDepthProgress(jobId, claimId, percent, message) {
  const db = await getDb();
  const rows = await db
    .update(generations)
    .set({
      progressPercent: Math.max(0, Math.min(100, Math.round(percent))),
      progressMessage: message ?? null,
      updatedAt: Date.now(),
    })
    .where(claimCondition(jobId, claimId))
    .returning({ id: generations.id });
  return rows.length > 0;
}

/** Mark a depth job finished — success with the stored output key/aspect
 *  ratio, or failure with a message. progress is cleared either way: once a
 *  row leaves "running", 0-100 no longer means anything for it, and leaving
 *  a stale 87% on a failed row would read as "almost done". */
export async function completeDepthJob(jobId, claimId, result) {
  const db = await getDb();
  const now = Date.now();
  if (result.ok) {
    const rows = await db
      .update(generations)
      .set({
        status: "succeeded",
        url: result.url,
        aspectRatio: result.aspectRatio ?? sql`aspect_ratio`,
        progressPercent: null,
        progressMessage: null,
        depthClaimId: null,
        depthClaimWorkerId: null,
        updatedAt: now,
      })
      .where(claimCondition(jobId, claimId))
      .returning({ id: generations.id });
    return rows.length > 0;
  } else {
    const rows = await db
      .update(generations)
      .set({
        status: "failed",
        error: result.error || "Depth worker reported failure.",
        progressPercent: null,
        progressMessage: null,
        depthClaimId: null,
        depthClaimWorkerId: null,
        updatedAt: now,
      })
      .where(claimCondition(jobId, claimId))
      .returning({ id: generations.id });
    return rows.length > 0;
  }
}

export async function isActiveDepthClaim(jobId, claimId) {
  const db = await getDb();
  const rows = await db
    .select({ id: generations.id })
    .from(generations)
    .where(claimCondition(jobId, claimId))
    .limit(1);
  return rows.length > 0;
}

/** Upsert a worker's heartbeat row. `workerId` (not the row's own uuid) is
 *  the stable key — see schema.js's docstring on depth_workers for why. */
export async function upsertDepthWorkerHeartbeat(w) {
  const db = await getDb();
  const now = Date.now();
  const values = {
    workerId: w.workerId,
    label: w.label ?? null,
    device: w.device ?? null,
    status: w.status ?? "idle",
    currentJobId: w.currentJobId ?? null,
    currentClaimId: w.currentClaimId ?? null,
    protocolVersion: w.protocolVersion ?? 1,
    ramLimitMb: w.ramLimitMb ?? null,
    ramUsedMb: w.ramUsedMb ?? null,
    lastSeenAt: now,
    createdAt: now,
  };
  await db
    .insert(depthWorkers)
    .values(values)
    .onConflictDoUpdate({
      target: depthWorkers.workerId,
      set: {
        label: values.label,
        device: values.device,
        status: values.status,
        currentJobId: values.currentJobId,
        currentClaimId: values.currentClaimId,
        protocolVersion: values.protocolVersion,
        ramLimitMb: values.ramLimitMb,
        ramUsedMb: values.ramUsedMb,
        lastSeenAt: values.lastSeenAt,
      },
    });
}

/**
 * Requeue work whose version-2 lease no longer has a matching fresh worker
 * heartbeat. Legacy null-claim rows are excluded during the server-first
 * rollout so they retain the old behavior until their worker is upgraded.
 */
export async function reapStaleDepthJobs({ force = false, now = Date.now(), db: suppliedDb } = {}) {
  if (!force && now - lastDepthReapAt < REAP_INTERVAL_MS) return 0;
  lastDepthReapAt = now;
  const db = suppliedDb ?? await getDb();
  const res = await db.execute(sql`
    update ${generations}
    set
      depth_reap_attempts = depth_reap_attempts + 1,
      status = case
        when depth_reap_attempts + 1 >= ${MAX_DEPTH_REAP_ATTEMPTS} then 'failed'
        else 'queued'
      end,
      error = case
        when depth_reap_attempts + 1 >= ${MAX_DEPTH_REAP_ATTEMPTS}
          then 'Depth worker went offline while processing this job, and it could not be recovered after multiple attempts.'
        else null
      end,
      progress_percent = null,
      progress_message = null,
      depth_claim_id = null,
      depth_claim_worker_id = null,
      updated_at = ${now}
    where kind = 'depth'
      and status = 'running'
      and depth_claim_id is not null
      and updated_at < ${now - DEPTH_CLAIM_GRACE_MS}
      and not exists (
        select 1 from ${depthWorkers} worker
        where worker.worker_id = ${generations}.depth_claim_worker_id
          and worker.current_job_id = ${generations}.id
          and worker.current_claim_id = ${generations}.depth_claim_id
          and worker.protocol_version >= ${DEPTH_WORKER_PROTOCOL_VERSION}
          and worker.last_seen_at >= ${now - WORKER_STALE_MS}
      )
    returning id
  `);
  return (res.rows ?? res).length;
}

/**
 * Status for the composer's status pill: whether any worker is online (by
 * heartbeat recency, never a stored flag — see schema.js), how many depth
 * jobs are queued, and the currently-running job's progress if there is one.
 * Deliberately a single combined read rather than three round trips, since
 * this is polled from the browser every few seconds.
 */
export async function readDepthWorkerStatus() {
  await reapStaleDepthJobs();
  const db = await getDb();
  const now = Date.now();
  const workers = await db.select().from(depthWorkers);
  const online = workers.filter((w) => now - Number(w.lastSeenAt) < WORKER_STALE_MS);

  const queuedRes = await db.execute(sql`
    select count(*)::int as n from ${generations}
    where kind = 'depth' and status = 'queued'
  `);
  const queuedRows = queuedRes.rows ?? queuedRes;
  const queueDepth = Number(queuedRows[0]?.n ?? 0);

  const runningWorker = online.find((w) => w.status === "busy" && w.currentJobId);
  let currentJob;
  if (runningWorker?.currentJobId) {
    const rows = await db
      .select({
        id: generations.id,
        progressPercent: generations.progressPercent,
        progressMessage: generations.progressMessage,
      })
      .from(generations)
      .where(eq(generations.id, runningWorker.currentJobId))
      .limit(1);
    if (rows[0]) {
      currentJob = {
        id: rows[0].id,
        progressPercent: rows[0].progressPercent ?? undefined,
        progressMessage: rows[0].progressMessage ?? undefined,
      };
    }
  }

  return {
    online: online.length > 0,
    workerCount: online.length,
    queueDepth,
    currentJob,
  };
}
