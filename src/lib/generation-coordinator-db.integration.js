import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { getDb } from "./db";
import { generations } from "./schema";
import { claimGeneration, releaseGeneration, selectDueGenerations } from "./generation-coordinator";
import { getItemByTaskId, markCallbackReceived } from "./store-db";
import { compareAndSetVideoOutcome } from "./video-poll-db";

function row(id, kind, status, now, overrides = {}) {
  return {
    id, kind, status, prompt: "coordinator integration", model: "Seedance 2.0",
    aspectRatio: "16:9", costCents: 0, createdAt: now, updatedAt: now,
    nextPollAt: now - 1, ...overrides,
  };
}

test("coordinator lookup, leases, callbacks, terminal CAS, and due index are database-safe", async () => {
  assert.ok(process.env.DATABASE_URL, "test:db requires a disposable PostgreSQL database");
  const db = await getDb();
  const ids = Array.from({ length: 5 }, () => randomUUID());
  const now = Date.now();
  const primaryTask = `primary-${ids[0]}`;
  const candidateTask = `candidate-${ids[0]}`;
  try {
    await db.insert(generations).values([
      row(ids[0], "video", "running", now, { taskId: primaryTask, candidateTaskIds: [candidateTask] }),
      row(ids[1], "video", "queued", now + 1),
      row(ids[2], "image", "queued", now + 2),
      row(ids[3], "image", "running", now + 3),
      row(ids[4], "depth", "queued", now + 4),
    ]);

    assert.equal((await getItemByTaskId(primaryTask, db))?.id, ids[0]);
    assert.equal((await getItemByTaskId(candidateTask, db))?.id, ids[0]);

    const claims = await Promise.all([
      claimGeneration(ids[1], "worker-a", { db, now, ttlMs: 100 }),
      claimGeneration(ids[1], "worker-b", { db, now, ttlMs: 100 }),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    const winner = claims[0] ? "worker-a" : "worker-b";
    const loser = winner === "worker-a" ? "worker-b" : "worker-a";
    assert.ok(await claimGeneration(ids[1], loser, { db, now: now + 101, ttlMs: 100 }));
    assert.equal(await releaseGeneration(ids[1], winner, { db }), undefined);

    const due = await selectDueGenerations({ db, now: now + 200, limit: 25 });
    assert.equal(due.some((item) => item.id === ids[3]), false, "running synchronous image excluded");
    assert.equal(due.some((item) => item.id === ids[4]), false, "depth excluded");

    const callback = await markCallbackReceived(candidateTask, now + 300, {
      providerStatus: "succeeded", providerUpdatedAt: now + 250,
    }, db);
    assert.equal(callback.callbackReceivedAt, now + 300);
    assert.equal(callback.providerStatus, "succeeded");

    const expected = { id: ids[0], status: "running", updatedAt: now, taskId: primaryTask };
    assert.equal((await compareAndSetVideoOutcome(expected, { status: "succeeded", url: "/done.mp4", updatedAt: now + 400 }, db))?.status, "succeeded");
    assert.equal(await compareAndSetVideoOutcome(expected, { status: "failed", updatedAt: now + 500 }, db), undefined);

    const indexRows = await db.execute(sql`
      select indexdef from pg_indexes
      where schemaname = current_schema() and tablename = 'generations'
        and indexname = 'generations_coordinator_due_idx'
    `);
    assert.equal(indexRows.rows?.length ?? indexRows.length, 1);
  } finally {
    await db.delete(generations).where(inArray(generations.id, ids));
  }
});
