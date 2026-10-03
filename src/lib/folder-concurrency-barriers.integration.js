import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { getDb } from "./db.js";
import { projects, folders, generations } from "./schema.js";
import {
  createFolder,
  renameFolder,
  moveFolder,
  moveGenerations,
  OrganizationError,
} from "./folder-engine.js";
import { deleteProject } from "./projects-db.js";
import { computeFingerprint } from "./idempotency.js";

function createBarrier() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return {
    wait: () => promise,
    signal: () => resolve(),
  };
}

test("BARRIER CONCURRENCY: Row-vs-scope deadlock prevention across independent sessions", async () => {
  assert.ok(process.env.DATABASE_URL, "Test requires DATABASE_URL");

  // Create two completely independent database sessions
  const sql1 = postgres(process.env.DATABASE_URL, { max: 1 });
  const sql2 = postgres(process.env.DATABASE_URL, { max: 1 });
  const db1 = drizzle(sql1);

  try {
    const actorId = randomUUID();
    const folder = await createFolder({
      name: `DeadlockTest-${randomUUID().slice(0, 8)}`,
      actorId,
    });

    const bSession1LockedScope = createBarrier();
    const bSession2Attempted = createBarrier();

    // Session 1: Holds scope lock on 'global' first
    const session1Promise = db1.transaction(async (tx1) => {
      await tx1.execute(sql`SELECT pg_advisory_xact_lock(hashtext('global'))`);
      bSession1LockedScope.signal();

      // Wait until Session 2 has started and is waiting on scope lock
      await bSession2Attempted.wait();

      // Now Session 1 locks the folder row FOR UPDATE
      await tx1
        .select()
        .from(folders)
        .where(eq(folders.id, folder.id))
        .for("update");

      // Commit transaction
    });

    // Session 2: Tries to rename the folder (which must acquire scope lock FIRST, preventing row-vs-scope deadlock)
    const session2Promise = (async () => {
      await bSession1LockedScope.wait();

      const renamePromise = renameFolder({
        folderId: folder.id,
        name: `RenamedNoDeadlock-${randomUUID().slice(0, 6)}`,
        actorId,
      });

      bSession2Attempted.signal();
      return await renamePromise;
    })();

    // Both sessions must complete within bounded time without PostgreSQL 40P01 deadlock
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Deadlock detected: bounded timeout exceeded")), 5000)
    );

    const [_, renameResult] = await Promise.race([
      Promise.all([session1Promise, session2Promise]),
      timeout,
    ]);

    assert.ok(renameResult.id);
    assert.equal(renameResult.version, 2, "Rename must succeed cleanly after session 1 releases scope lock");
  } finally {
    await sql1.end();
    await sql2.end();
  }
});

test("BARRIER CONCURRENCY: Same-key concurrent duplicate across two independent sessions", async () => {
  assert.ok(process.env.DATABASE_URL, "Test requires DATABASE_URL");

  const sql1 = postgres(process.env.DATABASE_URL, { max: 1 });
  const sql2 = postgres(process.env.DATABASE_URL, { max: 1 });
  const db1 = drizzle(sql1);

  try {
    const key = `barrier-idem-${randomUUID()}`;
    const actorId = randomUUID();
    const folderName = `BarrierIdem-${randomUUID().slice(0, 8)}`;

    const bSession1AcquiredIdemLock = createBarrier();
    const bSession2Blocked = createBarrier();

    // Session 1: Takes advisory lock on idempotency key, pauses, then completes createFolder
    const session1Promise = (async () => {
      // Create folder via standard engine with the key
      return await db1.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${'idempotency:' + key}))`
        );
        bSession1AcquiredIdemLock.signal();
        await bSession2Blocked.wait();

        // Perform actual folder creation
        const now = Date.now();
        const [inserted] = await tx
          .insert(folders)
          .values({
            name: folderName,
            nameNormalized: folderName.toLowerCase(),
            projectId: null,
            parentId: null,
            version: 1,
            createdAt: now,
            updatedAt: now,
          })
          .returning();

        const res = { id: inserted.id, name: inserted.name };
        const fp = computeFingerprint({ name: folderName, projectId: null, parentId: null });
        await tx.execute(sql`
          INSERT INTO organization_idempotency_keys (key, actor_id, operation, fingerprint, status, result, created_at, expires_at)
          VALUES (${key}, ${actorId}, 'create_folder', ${fp}, 'completed', ${JSON.stringify(res)}::jsonb, ${now}, ${now + 86400000})
        `);
        return res;
      });
    })();

    // Session 2: Tries to call createFolder with the exact same key concurrently
    const session2Promise = (async () => {
      await bSession1AcquiredIdemLock.wait();

      const callPromise = createFolder({
        name: folderName,
        actorId,
        idempotencyKey: key,
      });

      bSession2Blocked.signal();
      return await callPromise;
    })();

    const [res1, res2] = await Promise.all([session1Promise, session2Promise]);
    assert.equal(res1.id, res2.id, "Both sessions must return the exact same folder ID");

    // Only 1 folder must exist in DB
    const db = await getDb();
    const count = await db.select().from(folders).where(eq(folders.name, folderName));
    assert.equal(count.length, 1, "Exactly one folder row must exist in the database");
  } finally {
    await sql1.end();
    await sql2.end();
  }
});

test("BARRIER CONCURRENCY: Two opposing subtree moves serialize and reject cycle creation", async () => {
  const actorId = randomUUID();
  const folderA = await createFolder({ name: `FolderA-${randomUUID().slice(0, 6)}`, actorId });
  const folderB = await createFolder({ name: `FolderB-${randomUUID().slice(0, 6)}`, actorId });

  // Move A into B AND B into A concurrently
  const pA = moveFolder({
    folderId: folderA.id,
    destination: { type: "folder", folderId: folderB.id },
    actorId,
  });

  const pB = moveFolder({
    folderId: folderB.id,
    destination: { type: "folder", folderId: folderA.id },
    actorId,
  });

  const results = await Promise.allSettled([pA, pB]);

  // Exactly one must succeed and the other must be rejected (either CYCLE_DETECTED or VERSION_CONFLICT)
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");

  assert.equal(fulfilled.length, 1, "Exactly one opposing move must succeed");
  assert.equal(rejected.length, 1, "The opposing move must be rejected");

  const err = rejected[0].reason;
  assert.ok(err instanceof OrganizationError);
  assert.ok(
    err.code === "CYCLE_DETECTED" || err.code === "VERSION_CONFLICT",
    `Error code must be CYCLE_DETECTED or VERSION_CONFLICT, got ${err.code}`
  );

  // Verify DB state: no cycle exists
  const db = await getDb();
  const [rowA] = await db.select().from(folders).where(eq(folders.id, folderA.id));
  const [rowB] = await db.select().from(folders).where(eq(folders.id, folderB.id));

  const hasCycle =
    (rowA.parentId === folderB.id && rowB.parentId === folderA.id);
  assert.equal(hasCycle, false, "Database must never contain a cycle between opposing folders");
});

test("BARRIER CONCURRENCY: Destination scope changing during generation relocation maintains scope integrity", async () => {
  const db = await getDb();
  const actorId = randomUUID();
  const now = Date.now();

  const p1Id = randomUUID();
  const p2Id = randomUUID();
  await db.insert(projects).values([
    { id: p1Id, name: "Project 1", createdAt: now, updatedAt: now },
    { id: p2Id, name: "Project 2", createdAt: now, updatedAt: now },
  ]);

  // Destination folder in Project 1
  const targetFolder = await createFolder({
    name: `Target-${randomUUID().slice(0, 6)}`,
    projectId: p1Id,
    actorId,
  });

  // Generation initially in Project 1 Unsorted
  const genId = randomUUID();
  await db.insert(generations).values({
    id: genId,
    kind: "image",
    status: "succeeded",
    prompt: "scope race test",
    model: "flux",
    aspectRatio: "1:1",
    projectId: p1Id,
    folderId: null,
    locationVersion: 1,
    createdAt: now,
    updatedAt: now,
  });

  // Launch moveFolder (P1 -> P2) AND moveGenerations (into targetFolder) concurrently
  const pMoveFolder = moveFolder({
    folderId: targetFolder.id,
    destination: { type: "project_root", projectId: p2Id },
    actorId,
  });

  const pMoveGen = moveGenerations({
    ids: [genId],
    destination: { type: "folder", folderId: targetFolder.id },
    actorId,
  });

  const [resFolder, resGen] = await Promise.all([pMoveFolder, pMoveGen]);
  assert.ok(resFolder);
  assert.ok(resGen);

  // Both folder and generation MUST end up with matching project_id in P2!
  const [finalFolder] = await db.select().from(folders).where(eq(folders.id, targetFolder.id));
  const [finalGen] = await db.select().from(generations).where(eq(generations.id, genId));

  assert.equal(finalFolder.projectId, p2Id, "Folder must be in Project 2");
  assert.equal(finalGen.projectId, p2Id, "Generation must match folder's Project 2 scope");
  assert.equal(finalGen.folderId, targetFolder.id, "Generation must be in targetFolder");
});

test("BARRIER CONCURRENCY: Project deletion vs folder creation race serializes cleanly", async () => {
  const db = await getDb();
  const now = Date.now();
  const projId = randomUUID();
  const actorId = randomUUID();

  await db.insert(projects).values({
    id: projId,
    name: "Race Project",
    createdAt: now,
    updatedAt: now,
  });

  // Delete project AND create folder in project concurrently
  const pDelete = deleteProject(projId, actorId);
  const pCreate = createFolder({
    projectId: projId,
    name: "Race Child",
    actorId,
  });

  const [resDelete, resCreate] = await Promise.allSettled([pDelete, pCreate]);

  // Exactly one of two clean outcomes must happen:
  // Outcome A: Create wins -> Project deletion is refused with PROJECT_NOT_EMPTY
  // Outcome B: Delete wins -> Folder creation fails with PROJECT_NOT_FOUND
  if (resCreate.status === "fulfilled") {
    assert.equal(resDelete.status, "rejected", "Delete must be refused if folder was created first");
    assert.equal(resDelete.reason.code, "PROJECT_NOT_EMPTY");
  } else {
    assert.equal(resCreate.status, "rejected", "Folder creation must fail if project was deleted first");
    assert.equal(resCreate.reason.code, "PROJECT_NOT_FOUND");
    assert.equal(resDelete.status, "fulfilled", "Project deletion must succeed if it ran first");
  }

  // Relational integrity verified: no orphaned folder exists
  const projFolders = await db.select().from(folders).where(eq(folders.projectId, projId));
  const [projRow] = await db.select().from(projects).where(eq(projects.id, projId));

  if (!projRow) {
    assert.equal(projFolders.length, 0, "No folders can exist for a deleted project");
  }
});
