import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { generations, settings, userLimits } from "@/lib/schema";
import { lockJob, upsertItem } from "@/lib/store-db";

const createdIds = [];
const createdUsers = [];

function fixture(kind, userId, createdAt, status = "queued") {
  const row = {
    id: randomUUID(), kind, status, userId, prompt: "queue admission fixture",
    model: kind === "image" ? "seedream-5-pro" : "queue-fixture",
    aspectRatio: "1:1", createdAt, updatedAt: createdAt,
  };
  createdIds.push(row.id);
  return row;
}

test("Postgres admission enforces aggregate user and global kind ceilings atomically", async () => {
  assert.ok(process.env.DATABASE_URL, "test:db requires a disposable PostgreSQL database");
  const db = await getDb();
  const [previous] = await db.select().from(settings).where(eq(settings.key, "maxConcurrentJobs")).limit(1);
  const now = Date.now();
  try {
    await db.insert(settings).values({ key: "maxConcurrentJobs", value: "4", updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value: "4", updatedAt: now } });

    const userA = randomUUID();
    const userB = randomUUID();
    createdUsers.push(userA, userB);
    const mixed = Array.from({ length: 5 }, (_, i) => fixture(i % 2 ? "video" : "image", userA, now + i));
    const other = fixture("image", userB, now + 10);
    for (const row of [...mixed, other]) await upsertItem(row);
    const results = await Promise.all(mixed.map((row) => lockJob(row.id)));
    assert.equal(results.filter(Boolean).length, 4);
    assert.equal(await lockJob(other.id), true, "another user remains eligible");

    const lowerUser = randomUUID();
    createdUsers.push(lowerUser);
    await db.insert(userLimits).values({ userId: lowerUser, key: "maxConcurrentJobs", value: "2", updatedAt: now });
    const lower = [fixture("image", lowerUser, now + 20), fixture("video", lowerUser, now + 21), fixture("image", lowerUser, now + 22)];
    for (const row of lower) await upsertItem(row);
    assert.deepEqual(await Promise.all(lower.map((row) => lockJob(row.id))), [true, true, false]);

    // Distinct users remove the per-user cap from the equation and expose the
    // two global kind ceilings directly.
    await db.delete(generations).where(inArray(generations.id, createdIds));
    createdIds.length = 0;
    for (const [kind, cap, offset] of [["image", 10, 100], ["video", 6, 200]]) {
      const rows = [];
      for (let i = 0; i < cap + 1; i += 1) {
        const userId = randomUUID();
        createdUsers.push(userId);
        rows.push(fixture(kind, userId, now + offset + i));
      }
      for (const row of rows) await upsertItem(row);
      const admitted = await Promise.all(rows.map((row) => lockJob(row.id)));
      assert.equal(admitted.filter(Boolean).length, cap, `${kind} global ceiling`);
      await db.delete(generations).where(inArray(generations.id, rows.map((row) => row.id)));
      createdIds.splice(0, createdIds.length, ...createdIds.filter((id) => !rows.some((row) => row.id === id)));
    }
  } finally {
    if (createdIds.length) await db.delete(generations).where(inArray(generations.id, createdIds));
    if (createdUsers.length) await db.delete(userLimits).where(and(inArray(userLimits.userId, createdUsers), eq(userLimits.key, "maxConcurrentJobs")));
    if (previous) {
      await db.insert(settings).values(previous).onConflictDoUpdate({ target: settings.key, set: { value: previous.value, updatedAt: previous.updatedAt } });
    } else {
      await db.delete(settings).where(eq(settings.key, "maxConcurrentJobs"));
    }
  }
});
