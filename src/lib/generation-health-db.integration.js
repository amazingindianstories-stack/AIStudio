import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db";
import {
  checkGenerationIndexes,
  checkStuckGenerations,
  DEPTH_WORKER_STALE_MS,
  STUCK_DEPTH_GRACE_MS,
  STUCK_IMAGE_MS,
  STUCK_VIDEO_MS,
} from "@/lib/generation-health";
import { depthWorkers } from "@/lib/schema";
import { deleteItem, upsertItem } from "@/lib/store-db";

const now = 1_900_000_000_000;
const workerRowId = randomUUID();
const workerId = `health-${randomUUID()}`;
const healthyDepthId = randomUUID();

function generation(kind, updatedAt, patch = {}) {
  return {
    id: randomUUID(), kind, status: "running", prompt: "health fixture",
    model: "health-fixture", aspectRatio: "1:1", createdAt: updatedAt, updatedAt,
    ...patch,
  };
}

const rows = [
  generation("image", now - STUCK_IMAGE_MS - 1),
  generation("image", now - STUCK_IMAGE_MS + 1),
  generation("video", now - STUCK_VIDEO_MS - 1),
  generation("video", now - STUCK_VIDEO_MS + 1),
  generation("depth", now - STUCK_DEPTH_GRACE_MS - 1),
  generation("depth", now - STUCK_DEPTH_GRACE_MS - 1, { id: healthyDepthId }),
  generation("depth", now - STUCK_DEPTH_GRACE_MS + 1),
  generation("image", now - STUCK_IMAGE_MS - 1, { status: "complete" }),
];

test("live generation index check sees all reconciled indexes as valid", async () => {
  assert.deepEqual(await checkGenerationIndexes(), {
    status: "ok",
    detail: "10/10 expected indexes valid",
  });
});

test("stuck generation SQL respects kind thresholds and fresh depth workers", async () => {
  const db = await getDb();
  try {
    for (const row of rows) await upsertItem(row);
    await db.insert(depthWorkers).values({
      id: workerRowId,
      workerId,
      status: "busy",
      currentJobId: healthyDepthId,
      lastSeenAt: now - DEPTH_WORKER_STALE_MS + 1,
      createdAt: now,
    });

    const result = await checkStuckGenerations(undefined, now);
    assert.equal(result.status, "error");
    assert.match(result.detail, /^3 stuck — depth: 1 .*; image: 1 .*; video: 1 /);
    for (const row of rows) assert.doesNotMatch(result.detail, new RegExp(row.id));
  } finally {
    await db.delete(depthWorkers).where(eq(depthWorkers.id, workerRowId));
    await Promise.all(rows.map((row) => deleteItem(row.id)));
  }
});
