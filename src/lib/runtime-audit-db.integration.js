import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { count, eq, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { generations, userLimits, users } from "./schema";
import { getQueuePosition } from "./store-db";

async function cleanup(db, generationIds, userIds) {
  if (generationIds.length) await db.delete(generations).where(inArray(generations.id, generationIds));
  if (userIds.length) {
    await db.delete(userLimits).where(inArray(userLimits.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  }
}

test("PostgreSQL queue enforces per-user fairness, override precedence, and fixture cleanup", async () => {
  assert.ok(process.env.DATABASE_URL, "test:db requires a disposable PostgreSQL database");
  const db = await getDb();
  const userIds = [randomUUID(), randomUUID()];
  const generationIds = [randomUUID(), randomUUID(), randomUUID()];
  const now = Date.now();
  try {
    await db.insert(users).values(userIds.map((id, index) => ({
      id, email: `queue-audit-${id}@invalid.local`, passwordHash: "audit", passwordSalt: "audit",
      name: `Audit ${index}`, role: "user", isActive: true, authVersion: 0, createdAt: now,
    })));
    const base = { kind: "audit", prompt: "runtime audit integration", model: "audit", aspectRatio: "1:1", costCents: 0, updatedAt: now };
    await db.insert(generations).values([
      { ...base, id: generationIds[0], userId: userIds[0], status: "running", createdAt: now },
      { ...base, id: generationIds[1], userId: userIds[0], status: "queued", createdAt: now + 1 },
      { ...base, id: generationIds[2], userId: userIds[1], status: "queued", createdAt: now + 2 },
    ]);
    await db.insert(userLimits).values({
      userId: userIds[0], key: "maxConcurrentJobs", value: "1", updatedAt: now,
    });
    const [sameUser, otherUser] = await Promise.all([
      getQueuePosition(generationIds[1]), getQueuePosition(generationIds[2]),
    ]);
    assert.equal(sameUser.heldForConcurrency, true);
    assert.equal(otherUser.position, 0);

    await db.insert(userLimits).values({
      userId: userIds[0], key: "maxConcurrentJobs", value: "2", updatedAt: now,
    }).onConflictDoUpdate({
      target: [userLimits.userId, userLimits.key],
      set: { value: "2", updatedAt: now },
    });
    assert.equal((await getQueuePosition(generationIds[1])).position, 0);
  } finally {
    await cleanup(db, generationIds, userIds);
  }
  const [[generationCount], [userCount], [limitCount]] = await Promise.all([
    db.select({ n: count() }).from(generations).where(inArray(generations.id, generationIds)),
    db.select({ n: count() }).from(users).where(inArray(users.id, userIds)),
    db.select({ n: count() }).from(userLimits).where(inArray(userLimits.userId, userIds)),
  ]);
  assert.equal(Number(generationCount.n) + Number(userCount.n) + Number(limitCount.n), 0);
});

test("fixture cleanup still removes every row after a forced failure", async () => {
  const db = await getDb();
  const userId = randomUUID();
  try {
    await db.insert(users).values({
      id: userId, email: `forced-failure-${userId}@invalid.local`, passwordHash: "audit",
      passwordSalt: "audit", name: "Audit", role: "user", isActive: true, authVersion: 0, createdAt: Date.now(),
    });
    throw new Error("forced failure");
  } catch (error) {
    assert.match(error.message, /forced failure/);
  } finally {
    await cleanup(db, [], [userId]);
  }
  const [left] = await db.select({ n: count() }).from(users).where(eq(users.id, userId));
  assert.equal(Number(left.n), 0);
});
