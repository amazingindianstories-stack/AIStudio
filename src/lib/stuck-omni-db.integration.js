import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { getDb } from "@/lib/db";
import {
  finalizeRunningOmniRow,
  selectStaleRunningOmniRows,
} from "@/lib/stuck-omni-reconciliation";
import { deleteItem, getItem, upsertItem } from "@/lib/store-db";

const now = 1_900_000_000_000;
const reconciliationNow = now + 60 * 60_000;
const staleId = randomUUID();
const freshId = randomUUID();
const otherProviderId = randomUUID();

function row(id, patch = {}) {
  return {
    id,
    kind: "video",
    status: "running",
    prompt: "stuck Omni reconciliation fixture",
    model: "Gemini Omni Flash",
    aspectRatio: "16:9",
    taskId: `task-${id}`,
    createdAt: now,
    updatedAt: now,
    ...patch,
  };
}

const rows = [
  row(staleId),
  row(freshId, { updatedAt: reconciliationNow - 5 * 60_000 }),
  row(otherProviderId, { model: "Seedance 2.0" }),
];

test("stuck Omni selection is scoped and terminal updates are race-safe", async () => {
  assert.ok(process.env.DATABASE_URL, "test:db requires a disposable PostgreSQL database");
  const db = await getDb();
  try {
    for (const item of rows) await upsertItem(item);
    const selected = await selectStaleRunningOmniRows(db, {
      now: reconciliationNow,
      minAgeMinutes: 45,
      maxRows: 50,
    });
    assert.deepEqual(selected.map((item) => item.id), [staleId]);

    assert.equal(
      await finalizeRunningOmniRow(db, {
        id: staleId,
        taskId: "wrong-task",
        values: { status: "failed", error: "wrong", updatedAt: reconciliationNow },
      }),
      false
    );
    assert.equal((await getItem(staleId)).status, "running");

    assert.equal(
      await finalizeRunningOmniRow(db, {
        id: staleId,
        taskId: `task-${staleId}`,
        values: { status: "failed", error: "provider terminal", updatedAt: reconciliationNow },
      }),
      true
    );
    assert.equal((await getItem(staleId)).status, "failed");

    assert.equal(
      await finalizeRunningOmniRow(db, {
        id: staleId,
        taskId: `task-${staleId}`,
        values: { status: "succeeded", updatedAt: reconciliationNow + 1 },
      }),
      false
    );
    assert.equal((await getItem(staleId)).status, "failed");
  } finally {
    await Promise.all(rows.map((item) => deleteItem(item.id)));
  }
});
