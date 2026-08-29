import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { generations } from "./schema";
import {
  clearVideoPollErrors,
  compareAndSetVideoOutcome,
  recordVideoPollError,
  selectStaleVideoPollCandidates,
} from "./video-poll-db";

function row(id, updatedAt, overrides = {}) {
  return {
    id, kind: "video", status: "queued", prompt: "integration", model: "Seedance 2.0",
    aspectRatio: "16:9", taskId: `task-${id}`, costCents: 0,
    createdAt: updatedAt - 10, updatedAt, ...overrides,
  };
}

test("video poll health is atomic, staleness-preserving, ordered, bounded, and CAS-safe", async () => {
  assert.ok(process.env.DATABASE_URL, "test:db requires a disposable PostgreSQL database");
  const db = await getDb();
  const ids = Array.from({ length: 9 }, () => randomUUID());
  const base = 1_000_000;
  try {
    await db.insert(generations).values([
      ...ids.slice(0, 6).map((id, index) => row(id, base + index)),
      row(ids[6], base - 100, { taskId: null }),
      row(ids[7], base - 200, { status: "succeeded" }),
      row(ids[8], base + 10_000),
    ]);

    const expected = { id: ids[0], status: "queued", updatedAt: base, taskId: `task-${ids[0]}` };
    const increments = await Promise.all([
      recordVideoPollError(expected, base + 100, db),
      recordVideoPollError(expected, base + 101, db),
    ]);
    assert.deepEqual(increments.map((result) => result.pollErrorCount).sort(), [1, 2]);
    const [errored] = await db.select().from(generations).where(eq(generations.id, ids[0]));
    assert.equal(errored.updatedAt, base);
    assert.equal(errored.pollErrorCount, 2);

    const cleared = await clearVideoPollErrors(expected, db);
    assert.equal(cleared.pollErrorCount, 0);
    assert.equal(cleared.updatedAt, base);

    const selected = await selectStaleVideoPollCandidates({ before: base + 5, limit: 99, db });
    assert.equal(selected.length, 5);
    assert.deepEqual(selected.map((candidate) => candidate.id), ids.slice(0, 5));
    assert.equal(selected.some((candidate) => candidate.id === ids[6]), false);

    const won = await compareAndSetVideoOutcome(expected, {
      status: "succeeded", url: "/winner.mp4", updatedAt: base + 1_000,
    }, db);
    const lost = await compareAndSetVideoOutcome(expected, {
      status: "failed", error: "late loser", updatedAt: base + 2_000,
    }, db);
    assert.equal(won.status, "succeeded");
    assert.equal(lost, undefined);
    const [final] = await db.select().from(generations).where(eq(generations.id, ids[0]));
    assert.equal(final.url, "/winner.mp4");
    assert.equal(final.error, null);
  } finally {
    await db.delete(generations).where(inArray(generations.id, ids));
  }
});
