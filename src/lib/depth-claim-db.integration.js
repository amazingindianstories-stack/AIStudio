import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { depthWorkers, generations, users } from "./schema";
import {
  claimNextDepthJob,
  completeDepthJob,
  DEPTH_CLAIM_GRACE_MS,
  MAX_DEPTH_REAP_ATTEMPTS,
  reapStaleDepthJobs,
  reportDepthProgress,
  WORKER_STALE_MS,
} from "./depth-jobs-db";

test("depth claims fence stale workers, preserve healthy work, and bound recovery", async () => {
  assert.ok(process.env.DATABASE_URL, "test:db requires a disposable PostgreSQL database");
  const db = await getDb();
  const userId = randomUUID();
  const fencedJobId = randomUUID();
  const completedJobId = randomUUID();
  const legacyJobId = randomUUID();
  const workerId = `depth-fixture-${randomUUID()}`;
  const now = Date.now();
  const base = {
    userId,
    kind: "depth",
    prompt: "depth claim integration",
    model: "Video Depth Anything",
    aspectRatio: "16:9",
    costCents: 0,
  };

  try {
    await db.insert(users).values({
      id: userId,
      email: `depth-claim-${userId}@invalid.local`,
      passwordHash: "fixture",
      passwordSalt: "fixture",
      name: "Depth Claim Fixture",
      role: "user",
      isActive: true,
      authVersion: 0,
      createdAt: now,
    });
    await db.insert(generations).values([
      { ...base, id: fencedJobId, status: "queued", createdAt: now, updatedAt: now },
      { ...base, id: completedJobId, status: "queued", createdAt: now + 1, updatedAt: now + 1 },
      { ...base, id: legacyJobId, status: "queued", createdAt: now + 2, updatedAt: now + 2 },
    ]);

    const fenced = await claimNextDepthJob(workerId, { protocolVersion: 2 });
    assert.equal(fenced.id, fencedJobId);
    assert.match(fenced.claimId, /^[0-9a-f-]{36}$/);
    assert.equal(await reportDepthProgress(fenced.id, randomUUID(), 80, "stale"), false);
    assert.equal(await reportDepthProgress(fenced.id, fenced.claimId, 25, "working"), true);
    assert.equal(await completeDepthJob(fenced.id, randomUUID(), { ok: false, error: "stale" }), false);

    await db.insert(depthWorkers).values({
      workerId,
      status: "busy",
      currentJobId: fenced.id,
      currentClaimId: fenced.claimId,
      protocolVersion: 2,
      lastSeenAt: now,
      createdAt: now,
    });
    await db.update(generations).set({ updatedAt: now - DEPTH_CLAIM_GRACE_MS - 1 })
      .where(eq(generations.id, fenced.id));
    assert.equal(await reapStaleDepthJobs({ force: true, now, db }), 0);

    await db.update(depthWorkers).set({ lastSeenAt: now - WORKER_STALE_MS - 1 })
      .where(eq(depthWorkers.workerId, workerId));
    assert.equal(await reapStaleDepthJobs({ force: true, now, db }), 1);
    let [row] = await db.select().from(generations).where(eq(generations.id, fenced.id));
    assert.equal(row.status, "queued");
    assert.equal(row.depthReapAttempts, 1);
    assert.equal(row.depthClaimId, null);

    for (let attempt = 2; attempt <= MAX_DEPTH_REAP_ATTEMPTS; attempt++) {
      await db.update(generations).set({
        status: "running",
        depthClaimId: randomUUID(),
        depthClaimWorkerId: workerId,
        updatedAt: now - DEPTH_CLAIM_GRACE_MS - attempt,
      }).where(eq(generations.id, fenced.id));
      assert.equal(await reapStaleDepthJobs({ force: true, now, db }), 1);
    }
    [row] = await db.select().from(generations).where(eq(generations.id, fenced.id));
    assert.equal(row.status, "failed");
    assert.equal(row.depthReapAttempts, MAX_DEPTH_REAP_ATTEMPTS);
    assert.match(row.error, /could not be recovered/);

    const completed = await claimNextDepthJob(workerId, { protocolVersion: 2 });
    assert.equal(completed.id, completedJobId);
    assert.equal(await completeDepthJob(completed.id, completed.claimId, {
      ok: true, url: "/api/media/depth-output/final.mp4", aspectRatio: "16:9",
    }), true);

    const legacy = await claimNextDepthJob(workerId, { protocolVersion: 1 });
    assert.equal(legacy.id, legacyJobId);
    assert.equal(legacy.claimId, undefined);
    await db.update(generations).set({ updatedAt: now - DEPTH_CLAIM_GRACE_MS - 10 })
      .where(eq(generations.id, legacy.id));
    assert.equal(await reapStaleDepthJobs({ force: true, now, db }), 0);
    assert.equal(await reportDepthProgress(legacy.id, undefined, 50, "legacy"), true);
    assert.equal(await completeDepthJob(legacy.id, undefined, {
      ok: true, url: "/api/media/depth-output/legacy.mp4",
    }), true);
  } finally {
    await db.delete(generations).where(inArray(generations.id, [fencedJobId, completedJobId, legacyJobId]));
    await db.delete(depthWorkers).where(eq(depthWorkers.workerId, workerId));
    await db.delete(users).where(eq(users.id, userId));
  }
});
