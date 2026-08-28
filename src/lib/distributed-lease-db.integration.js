import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { getDb } from "./db.js";
import {
  claimDistributedLease,
  readDistributedLease,
  releaseDistributedLease,
} from "./distributed-lease.js";

test("PostgreSQL lease permits one owner, expires, and releases owner-safely", async () => {
  assert.ok(process.env.DATABASE_URL, "test:db requires a disposable PostgreSQL database");
  const db = await getDb();
  const key = `lease:test:${randomUUID()}`;
  const first = randomUUID();
  const second = randomUUID();
  const now = Date.now();

  try {
    const claims = await Promise.all([
      claimDistributedLease(key, first, { db, now, ttlMs: 1_000 }),
      claimDistributedLease(key, second, { db, now, ttlMs: 1_000 }),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    const winner = claims[0] ? first : second;
    const loser = winner === first ? second : first;
    assert.equal((await readDistributedLease(key, { db }))?.owner, winner);
    assert.equal(await releaseDistributedLease(key, loser, { db }), false);
    assert.equal(
      await claimDistributedLease(key, loser, { db, now: now + 1_001, ttlMs: 1_000 }),
      true
    );
    assert.equal(await releaseDistributedLease(key, winner, { db }), false);
    assert.equal(await releaseDistributedLease(key, loser, { db }), true);
    assert.equal(await readDistributedLease(key, { db }), null);
  } finally {
    await releaseDistributedLease(key, first, { db });
    await releaseDistributedLease(key, second, { db });
  }
});
