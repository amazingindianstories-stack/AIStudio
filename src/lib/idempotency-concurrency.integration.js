import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "./db.js";
import { folders, organizationIdempotencyKeys } from "./schema.js";
import {
  createFolder,
  renameFolder,
  deleteFolder,
  moveFolder,
  OrganizationError,
} from "./folder-engine.js";
import {
  cleanExpiredIdempotencyKeys,
  computeFingerprint,
} from "./idempotency.js";

test("IDEMPOTENCY: Canonical fingerprint computation handles key ordering and nested structures", () => {
  const p1 = { a: 1, b: 2, nested: { x: "foo", y: "bar" } };
  const p2 = { b: 2, a: 1, nested: { y: "bar", x: "foo" } };
  const p3 = { a: 1, b: 3, nested: { x: "foo", y: "bar" } };

  assert.equal(computeFingerprint(p1), computeFingerprint(p2), "Identical content in different key order must yield identical fingerprint");
  assert.notEqual(computeFingerprint(p1), computeFingerprint(p3), "Different content must yield different fingerprint");
});

test("IDEMPOTENCY: Exact same-key concurrent requests serialize without duplicate mutations", async () => {
  const db = await getDb();
  const key = `idem-concurrent-${randomUUID()}`;
  const actorId = randomUUID();
  const folderName = `Concurrent-${randomUUID().slice(0, 8)}`;

  // Launch 5 concurrent calls with the exact same idempotencyKey and payload
  const promises = Array.from({ length: 5 }, () =>
    createFolder({
      name: folderName,
      actorId,
      idempotencyKey: key,
    })
  );

  const results = await Promise.all(promises);

  // All 5 must return the exact same folder ID
  const firstId = results[0].id;
  assert.ok(firstId, "Created folder must have an id");
  for (const r of results) {
    assert.equal(r.id, firstId, "All concurrent requests must return the exact same folder");
  }

  // Exactly one folder must exist in the database with this name
  const dbFolders = await db
    .select()
    .from(folders)
    .where(eq(folders.name, folderName));
  assert.equal(dbFolders.length, 1, "Only one folder row must be created in the database");

  // Exactly one key must exist in organization_idempotency_keys
  const [keyRow] = await db
    .select()
    .from(organizationIdempotencyKeys)
    .where(eq(organizationIdempotencyKeys.key, key));
  assert.ok(keyRow, "Idempotency key record must exist");
  assert.equal(keyRow.status, "completed");
  assert.equal(keyRow.actorId, actorId);
  assert.equal(keyRow.result.id, firstId);
});

test("IDEMPOTENCY: Same key with different payload is rejected with 409", async () => {
  const key = `idem-diff-payload-${randomUUID()}`;
  const actorId = randomUUID();

  // First request succeeds
  const f1 = await createFolder({
    name: `Payload-1-${randomUUID().slice(0, 8)}`,
    actorId,
    idempotencyKey: key,
  });
  assert.ok(f1.id);

  // Second request with SAME key but DIFFERENT payload must be rejected
  await assert.rejects(
    async () => {
      await createFolder({
        name: `Payload-2-${randomUUID().slice(0, 8)}`,
        actorId,
        idempotencyKey: key,
      });
    },
    (err) => {
      assert.ok(err instanceof OrganizationError);
      assert.equal(err.code, "IDEMPOTENCY_PAYLOAD_MISMATCH");
      assert.equal(err.status, 409);
      return true;
    }
  );
});

test("IDEMPOTENCY: Same key with different actor is rejected with 409", async () => {
  const key = `idem-diff-actor-${randomUUID()}`;
  const actor1 = randomUUID();
  const actor2 = randomUUID();
  const folderName = `ActorTest-${randomUUID().slice(0, 8)}`;

  // First request by actor1
  const f1 = await createFolder({
    name: folderName,
    actorId: actor1,
    idempotencyKey: key,
  });
  assert.ok(f1.id);

  // Second request by actor2 with same key
  await assert.rejects(
    async () => {
      await createFolder({
        name: folderName,
        actorId: actor2,
        idempotencyKey: key,
      });
    },
    (err) => {
      assert.ok(err instanceof OrganizationError);
      assert.equal(err.code, "IDEMPOTENCY_ACTOR_MISMATCH");
      assert.equal(err.status, 409);
      return true;
    }
  );
});

test("IDEMPOTENCY: Cross-operation key reuse is rejected with 409", async () => {
  const key = `idem-cross-op-${randomUUID()}`;
  const actorId = randomUUID();

  // Create folder using key
  const f = await createFolder({
    name: `CrossOp-${randomUUID().slice(0, 8)}`,
    actorId,
    idempotencyKey: key,
  });
  assert.ok(f.id);

  // Attempt to reuse same key for renameFolder
  await assert.rejects(
    async () => {
      await renameFolder({
        folderId: f.id,
        name: `Renamed-${randomUUID().slice(0, 8)}`,
        actorId,
        idempotencyKey: key,
      });
    },
    (err) => {
      assert.ok(err instanceof OrganizationError);
      assert.equal(err.code, "IDEMPOTENCY_OPERATION_MISMATCH");
      assert.equal(err.status, 409);
      return true;
    }
  );
});

test("IDEMPOTENCY: Retry-after-deletion returns cached result and does not throw 404", async () => {
  const actorId = randomUUID();
  const folder = await createFolder({
    name: `DeleteRetry-${randomUUID().slice(0, 8)}`,
    actorId,
  });

  const deleteKey = `idem-delete-${randomUUID()}`;

  // First delete call
  const delRes1 = await deleteFolder({
    folderId: folder.id,
    actorId,
    idempotencyKey: deleteKey,
  });
  assert.equal(delRes1.success, true);
  assert.equal(delRes1.deletedFolderId, folder.id);

  // Retry delete call with exact same key (simulating network blip retry)
  const delRes2 = await deleteFolder({
    folderId: folder.id,
    actorId,
    idempotencyKey: deleteKey,
  });
  assert.deepEqual(delRes2, delRes1, "Replaying deletion with same idempotencyKey must return identical success result");
});

test("IDEMPOTENCY: Lost-response replay returns cached result without re-executing", async () => {
  const db = await getDb();
  const actorId = randomUUID();
  const root = await createFolder({ name: `ReplayRoot-${randomUUID().slice(0, 6)}`, actorId });
  const child = await createFolder({ name: `ReplayChild-${randomUUID().slice(0, 6)}`, parentId: root.id, actorId });

  const moveKey = `idem-move-${randomUUID()}`;

  // Move child to global root
  const move1 = await moveFolder({
    folderId: child.id,
    destination: { type: "global_root" },
    actorId,
    idempotencyKey: moveKey,
  });
  assert.equal(move1.folder.parentId, null);
  const versionAfterFirstMove = move1.folder.version;

  // Replay exact move request
  const move2 = await moveFolder({
    folderId: child.id,
    destination: { type: "global_root" },
    actorId,
    idempotencyKey: moveKey,
  });

  assert.deepEqual(move2, move1, "Replay must return exact cached result");

  // Verify in database that folder version did NOT increment again
  const [dbFolder] = await db
    .select({ version: folders.version })
    .from(folders)
    .where(eq(folders.id, child.id));
  assert.equal(dbFolder.version, versionAfterFirstMove, "Version must not change on idempotent replay");
});

test("IDEMPOTENCY: Expiry cleanup purges expired keys and allows subsequent execution", async () => {
  const db = await getDb();
  const key = `idem-expired-${randomUUID()}`;
  const actorId = randomUUID();
  const now = Date.now();

  // Insert an expired key directly into DB (expired 1 hour ago)
  await db.insert(organizationIdempotencyKeys).values({
    key,
    actorId,
    operation: "create_folder",
    fingerprint: "dummy-fingerprint",
    status: "completed",
    result: { id: "old-dummy-id" },
    createdAt: now - 7200000,
    expiresAt: now - 3600000,
  });

  // Run cleanup
  await cleanExpiredIdempotencyKeys(db, now);

  // Key must be gone from DB
  const [cleaned] = await db
    .select()
    .from(organizationIdempotencyKeys)
    .where(eq(organizationIdempotencyKeys.key, key));
  assert.equal(cleaned, undefined, "Expired key must be purged by cleanExpiredIdempotencyKeys");

  // Subsequent call with this key succeeds freshly
  const folder = await createFolder({
    name: `FreshAfterExpiry-${randomUUID().slice(0, 6)}`,
    actorId,
    idempotencyKey: key,
  });
  assert.ok(folder.id);
  assert.notEqual(folder.id, "old-dummy-id", "Fresh folder must be created after key expiry");
});
