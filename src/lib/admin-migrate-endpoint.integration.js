import test from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { getDb } from "./db.js";
import { POST } from "../app/api/admin/migrate-schema/route.js";

/**
 * Admin Migrate Schema Endpoint Regression Test Suite
 *
 * Verifies:
 * 1. 403 Forbidden on unauthenticated requests.
 * 2. 200 OK and verified === true on valid authorized request.
 * 3. Exact count properties returned without ReferenceError.
 * 4. Strictly idempotent re-run.
 * 5. Clean transaction rollback and 500 response on simulated failure.
 */

test("Admin migrate-schema endpoint: rejects unauthenticated requests with 403", async () => {
  const req = new Request("http://localhost/api/admin/migrate-schema", {
    method: "POST",
  });
  const res = await POST(req);
  assert.equal(res.status, 403);
  const json = await res.json();
  assert.equal(json.error, "FORBIDDEN");
});

test("Admin migrate-schema endpoint: 200 OK, verified === true, and idempotent re-run", async () => {
  assert.ok(process.env.DATABASE_URL, "test requires DATABASE_URL");

  const originalSecret = process.env.SET_TOKEN_SECRET;
  process.env.SET_TOKEN_SECRET = "test-admin-secret-2026";

  try {
    // 1. First execution: authenticated request
    const req1 = new Request("http://localhost/api/admin/migrate-schema", {
      method: "POST",
      headers: {
        "x-setup-secret": "test-admin-secret-2026",
      },
    });
    const res1 = await POST(req1);
    assert.equal(res1.status, 200);

    const body1 = await res1.json();
    assert.equal(body1.success, true);
    assert.equal(body1.verified, true);
    assert.equal(body1.coordinatorColumns, 21);
    assert.equal(body1.portraitTables, 2);
    assert.equal(body1.mediaExportTables, 2);
    assert.equal(body1.hierarchicalFolderColumns, 4);
    assert.equal(body1.generationNamingTables, 2);

    // 2. Second execution: strictly idempotent re-run
    const req2 = new Request("http://localhost/api/admin/migrate-schema", {
      method: "POST",
      headers: {
        "x-setup-secret": "test-admin-secret-2026",
      },
    });
    const res2 = await POST(req2);
    assert.equal(res2.status, 200);

    const body2 = await res2.json();
    assert.equal(body2.success, true);
    assert.equal(body2.verified, true);
    assert.equal(body2.coordinatorColumns, 21);
    assert.equal(body2.portraitTables, 2);
    assert.equal(body2.mediaExportTables, 2);
    assert.equal(body2.hierarchicalFolderColumns, 4);
    assert.equal(body2.generationNamingTables, 2);
  } finally {
    if (originalSecret !== undefined) {
      process.env.SET_TOKEN_SECRET = originalSecret;
    } else {
      delete process.env.SET_TOKEN_SECRET;
    }
  }
});

test("Admin migrate-schema endpoint: rolls back transaction on simulated failure", async () => {
  assert.ok(process.env.DATABASE_URL, "test requires DATABASE_URL");

  const originalSecret = process.env.SET_TOKEN_SECRET;
  process.env.SET_TOKEN_SECRET = "test-admin-secret-2026";

  const db = await getDb();
  const originalTransaction = db.transaction;
  let transactionAttempted = false;

  try {
    // Intercept transaction to write a canary table and throw
    db.transaction = async (_callback) => {
      transactionAttempted = true;
      return originalTransaction.call(db, async (tx) => {
        await tx.execute(sql`CREATE TABLE IF NOT EXISTS admin_migrate_canary_proof (id int)`);
        await tx.execute(sql`INSERT INTO admin_migrate_canary_proof VALUES (12345)`);
        throw new Error("SIMULATED_ADMIN_MIGRATION_FAILURE");
      });
    };

    const req = new Request("http://localhost/api/admin/migrate-schema", {
      method: "POST",
      headers: {
        "x-setup-secret": "test-admin-secret-2026",
      },
    });
    const res = await POST(req);
    assert.equal(res.status, 500);

    const body = await res.json();
    assert.equal(body.error, "SIMULATED_ADMIN_MIGRATION_FAILURE");
    assert.equal(transactionAttempted, true);

    // Verify transaction rollback: canary table must not exist
    const canaryCheck = await db.execute(sql`
      SELECT 1 FROM information_schema.tables
      WHERE table_name = 'admin_migrate_canary_proof'
        AND table_schema = current_schema();
    `);
    assert.equal((canaryCheck.rows ?? canaryCheck).length, 0, "Canary table must be rolled back");
  } finally {
    db.transaction = originalTransaction;
    if (originalSecret !== undefined) {
      process.env.SET_TOKEN_SECRET = originalSecret;
    } else {
      delete process.env.SET_TOKEN_SECRET;
    }
  }
});
