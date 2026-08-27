import assert from "node:assert/strict";
import test from "node:test";
import { eq, sql } from "drizzle-orm";
import { getDb } from "./db.js";
import {
  LOGIN_ATTEMPT_WINDOW_MS,
  cleanupExpiredLoginAttempts,
  expiredLoginAttemptCutoff,
} from "./login-throttle.js";
import { loginAttempts } from "./schema.js";

test("global retention removes expired attempts and preserves recent attempts", async (t) => {
  const db = await getDb();
  const identifier = `retention-${crypto.randomUUID()}@example.test`;
  const now = Date.now();

  // Fresh CI databases are created by Django migrations, and MIG-03 tracks
  // that Django still has no model/migration for this JS-owned live table.
  // Provision only the table this integration fixture owns; do not smuggle a
  // Django cutover decision into an unrelated retention fix.
  await db.execute(sql`
    create table if not exists login_attempts (
      id uuid primary key,
      identifier text not null,
      created_at bigint not null
    )
  `);
  await db.execute(sql`
    create index if not exists login_attempts_identifier_created_idx
      on login_attempts (identifier, created_at)
  `);
  t.after(async () => {
    await db.delete(loginAttempts).where(eq(loginAttempts.identifier, identifier));
  });

  await db.insert(loginAttempts).values([
    { id: crypto.randomUUID(), identifier, createdAt: now - LOGIN_ATTEMPT_WINDOW_MS - 1 },
    { id: crypto.randomUUID(), identifier, createdAt: expiredLoginAttemptCutoff(now) },
    { id: crypto.randomUUID(), identifier, createdAt: now - LOGIN_ATTEMPT_WINDOW_MS + 1 },
    { id: crypto.randomUUID(), identifier, createdAt: now },
  ]);

  const deleted = await cleanupExpiredLoginAttempts(now);
  assert.ok(deleted >= 2);
  const rows = await db
    .select({ createdAt: loginAttempts.createdAt })
    .from(loginAttempts)
    .where(eq(loginAttempts.identifier, identifier));
  assert.deepEqual(rows.map((row) => row.createdAt).sort(), [
    now - LOGIN_ATTEMPT_WINDOW_MS + 1,
    now,
  ]);
});
