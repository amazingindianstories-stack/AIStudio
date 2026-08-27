import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { queryAdminLogs } from "./admin-logs.js";
import { deleteItem, upsertItem } from "./store-db.js";

test("PostgreSQL admin totals preserve explicit estimated and reconciled cost", async () => {
  assert.ok(process.env.DATABASE_URL, "test:db requires a disposable PostgreSQL database");
  const model = `cost-basis-${randomUUID()}`;
  const now = Date.now();
  const rows = [
    { id: randomUUID(), status: "succeeded", costCents: 101, costBasis: "estimated" },
    { id: randomUUID(), status: "succeeded", costCents: 202, costBasis: "reconciled" },
    // Failed rows are visible in logs but do not count as recorded spend.
    { id: randomUUID(), status: "failed", costCents: 999, costBasis: "reconciled" },
  ].map((row, index) => ({
    kind: "image",
    prompt: "cost basis integration fixture",
    model,
    aspectRatio: "1:1",
    isFavorite: false,
    flagged: false,
    createdAt: now + index,
    updatedAt: now + index,
    ...row,
  }));

  try {
    for (const row of rows) await upsertItem(row);
    const result = await queryAdminLogs({ model }, undefined, 10);
    assert.equal(result.total, 3);
    assert.equal(result.totalCostCents, 303);
    assert.equal(result.reconciledCostCents, 202);
    assert.equal(result.estimatedCostCents, 101);
    assert.deepEqual(
      result.rows.map((row) => row.costBasis).sort(),
      ["estimated", "reconciled", "reconciled"]
    );
  } finally {
    await Promise.all(rows.map((row) => deleteItem(row.id)));
  }
});
