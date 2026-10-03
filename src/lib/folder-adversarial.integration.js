import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { getDb } from "./db.js";
import { projects, folders, generations } from "./schema.js";
import {
  createFolder,
  renameFolder,
  moveFolder,
  moveGenerations,
  OrganizationError,
  MAX_NESTING_DEPTH,
  MAX_GENERATION_BATCH,
} from "./folder-engine.js";
import { eq, inArray } from "drizzle-orm";

test("ADVERSARIAL: Folder cycle prevention rejects moving into self or descendant", async () => {
  const db = await getDb();
  const actorId = randomUUID();

  // Create a 3-level chain: Root -> Child -> Grandchild
  const root = await createFolder({ name: `Root-${randomUUID().slice(0, 6)}`, actorId });
  const child = await createFolder({ name: "Child", parentId: root.id, actorId });
  const grandchild = await createFolder({ name: "Grandchild", parentId: child.id, actorId });

  try {
    // 1. Moving folder into itself
    await assert.rejects(
      moveFolder({
        folderId: root.id,
        destination: { type: "folder", folderId: root.id },
        actorId,
      }),
      (err) => {
        assert.ok(err instanceof OrganizationError);
        assert.equal(err.code, "CANNOT_MOVE_INTO_SELF");
        return true;
      }
    );

    // 2. Moving parent into its child (cycle)
    await assert.rejects(
      moveFolder({
        folderId: root.id,
        destination: { type: "folder", folderId: child.id },
        actorId,
      }),
      (err) => {
        assert.ok(err instanceof OrganizationError);
        assert.equal(err.code, "CYCLE_DETECTED");
        return true;
      }
    );

    // 3. Moving parent into its deep descendant (grandchild)
    await assert.rejects(
      moveFolder({
        folderId: root.id,
        destination: { type: "folder", folderId: grandchild.id },
        actorId,
      }),
      (err) => {
        assert.ok(err instanceof OrganizationError);
        assert.equal(err.code, "CYCLE_DETECTED");
        return true;
      }
    );

    // 4. Moving child into grandchild
    await assert.rejects(
      moveFolder({
        folderId: child.id,
        destination: { type: "folder", folderId: grandchild.id },
        actorId,
      }),
      (err) => {
        assert.ok(err instanceof OrganizationError);
        assert.equal(err.code, "CYCLE_DETECTED");
        return true;
      }
    );
  } finally {
    await db.delete(folders).where(inArray(folders.id, [root.id, child.id, grandchild.id]));
  }
});

test("ADVERSARIAL: Sibling name collisions reject duplicate names across case and whitespace", async () => {
  const db = await getDb();
  const actorId = randomUUID();
  const baseName = `Coll-${randomUUID().slice(0, 6)}`;

  const f1 = await createFolder({ name: baseName, actorId });

  try {
    // Exact duplicate
    await assert.rejects(
      createFolder({ name: baseName, actorId }),
      (err) => {
        assert.ok(err instanceof OrganizationError);
        assert.equal(err.code, "DUPLICATE_FOLDER_NAME");
        return true;
      }
    );

    // Case-insensitive duplicate (e.g. "COLL-ABC")
    await assert.rejects(
      createFolder({ name: baseName.toUpperCase(), actorId }),
      (err) => {
        assert.ok(err instanceof OrganizationError);
        assert.equal(err.code, "DUPLICATE_FOLDER_NAME");
        return true;
      }
    );

    // Whitespace variant duplicate (e.g. "  Coll-ABC  ")
    await assert.rejects(
      createFolder({ name: `   ${baseName}   `, actorId }),
      (err) => {
        assert.ok(err instanceof OrganizationError);
        assert.equal(err.code, "DUPLICATE_FOLDER_NAME");
        return true;
      }
    );
  } finally {
    await db.delete(folders).where(eq(folders.id, f1.id));
  }
});

test("ADVERSARIAL: Hierarchy depth limit enforces maximum allowed depth", async () => {
  const db = await getDb();
  const actorId = randomUUID();
  const createdIds = [];

  try {
    let currentParent = null;
    // Create chain up to MAX_NESTING_DEPTH (20)
    for (let depth = 1; depth <= MAX_NESTING_DEPTH; depth++) {
      const folder = await createFolder({
        name: `L${depth}-${randomUUID().slice(0, 4)}`,
        parentId: currentParent?.id || null,
        actorId,
      });
      createdIds.push(folder.id);
      currentParent = folder;
    }

    // Creating one more at depth 21 must be rejected
    await assert.rejects(
      createFolder({
        name: "L21-Exceeded",
        parentId: currentParent.id,
        actorId,
      }),
      (err) => {
        assert.ok(err instanceof OrganizationError);
        assert.equal(err.code, "EXCEEDS_MAX_DEPTH");
        return true;
      }
    );
  } finally {
    // Delete in reverse order to respect FK
    for (let i = createdIds.length - 1; i >= 0; i--) {
      await db.delete(folders).where(eq(folders.id, createdIds[i]));
    }
  }
});

test("ADVERSARIAL: Cross-scope folder moves recursively update subtree generations and scope", async () => {
  const db = await getDb();
  const actorId = randomUUID();
  const now = Date.now();
  const projId = randomUUID();
  const genId = randomUUID();

  await db.insert(projects).values({ id: projId, name: "Target Proj", createdAt: now, updatedAt: now });

  // Create a global folder hierarchy: Parent -> Child
  const parent = await createFolder({ name: `GlobParent-${randomUUID().slice(0, 6)}`, actorId });
  const child = await createFolder({ name: "GlobChild", parentId: parent.id, actorId });

  // Insert a generation in the child folder with projectId null
  await db.insert(generations).values({
    id: genId,
    projectId: null,
    folderId: child.id,
    prompt: "Test cross scope",
    model: "fal-ai/flux/dev",
    aspectRatio: "1:1",
    kind: "image",
    status: "succeeded",
    createdAt: now,
    updatedAt: now,
  });

  try {
    // Move parent to the project root
    const moveResult = await moveFolder({
      folderId: parent.id,
      destination: { type: "project_root", projectId: projId },
      actorId,
    });

    assert.equal(moveResult.subtreeFolderCount, 2);
    assert.equal(moveResult.scopeChanged, true);

    // Verify parent has target projectId
    const [updatedParent] = await db.select().from(folders).where(eq(folders.id, parent.id));
    assert.equal(updatedParent.projectId, projId);
    assert.equal(updatedParent.parentId, null);

    // Verify child has target projectId
    const [updatedChild] = await db.select().from(folders).where(eq(folders.id, child.id));
    assert.equal(updatedChild.projectId, projId);

    // Verify generation in child has target projectId
    const [updatedGen] = await db.select().from(generations).where(eq(generations.id, genId));
    assert.equal(updatedGen.projectId, projId);
    assert.equal(updatedGen.folderId, child.id);

    // Move parent back to global root
    const moveBack = await moveFolder({
      folderId: parent.id,
      destination: { type: "global_root" },
      actorId,
    });
    assert.equal(moveBack.subtreeFolderCount, 2);
    assert.equal(moveBack.scopeChanged, true);

    const [finalParent] = await db.select().from(folders).where(eq(folders.id, parent.id));
    assert.equal(finalParent.projectId, null);

    const [finalGen] = await db.select().from(generations).where(eq(generations.id, genId));
    assert.equal(finalGen.projectId, null);
  } finally {
    await db.delete(generations).where(eq(generations.id, genId));
    await db.delete(folders).where(eq(folders.id, child.id));
    await db.delete(folders).where(eq(folders.id, parent.id));
    await db.delete(projects).where(eq(projects.id, projId));
  }
});

test("ADVERSARIAL: Generation moves enforce atomic batch limit and all-or-nothing rollback", async () => {
  const db = await getDb();
  const actorId = randomUUID();
  const now = Date.now();

  // Create target folder
  const folder = await createFolder({ name: `Target-${randomUUID().slice(0, 6)}`, actorId });

  // 1. Exceeding batch size
  const fakeIds = Array.from({ length: MAX_GENERATION_BATCH + 1 }, () => randomUUID());
  await assert.rejects(
    moveGenerations({
      ids: fakeIds,
      destination: { type: "folder", folderId: folder.id },
      actorId,
    }),
    (err) => {
      assert.ok(err instanceof OrganizationError);
      assert.equal(err.code, "BATCH_TOO_LARGE");
      return true;
    }
  );

  // 2. All-or-nothing rollback when one ID is missing
  const realId = randomUUID();
  const missingId = randomUUID();

  await db.insert(generations).values({
    id: realId,
    projectId: null,
    folderId: null,
    prompt: "Atomic test",
    model: "fal-ai/flux/dev",
    aspectRatio: "1:1",
    kind: "image",
    status: "succeeded",
    createdAt: now,
    updatedAt: now,
  });

  try {
    await assert.rejects(
      moveGenerations({
        ids: [realId, missingId],
        destination: { type: "folder", folderId: folder.id },
        actorId,
      }),
      (err) => {
        assert.ok(err instanceof OrganizationError);
        assert.equal(err.code, "GENERATION_NOT_FOUND");
        return true;
      }
    );

    // Verify realId was rolled back and NOT moved to folder
    const [unmovedGen] = await db.select().from(generations).where(eq(generations.id, realId));
    assert.equal(unmovedGen.folderId, null);
  } finally {
    await db.delete(generations).where(eq(generations.id, realId));
    await db.delete(folders).where(eq(folders.id, folder.id));
  }
});

test("ADVERSARIAL: Optimistic concurrency rejects conflicting concurrent version updates", async () => {
  const db = await getDb();
  const actorId = randomUUID();
  const folder = await createFolder({ name: `Ver-${randomUUID().slice(0, 6)}`, actorId });

  try {
    // Attempt rename with wrong expectedVersion
    await assert.rejects(
      renameFolder({
        folderId: folder.id,
        name: "New Name",
        expectedVersion: 999, // Current version is 1
        actorId,
      }),
      (err) => {
        assert.ok(err instanceof OrganizationError);
        assert.equal(err.code, "VERSION_CONFLICT");
        return true;
      }
    );

    // Attempt move with wrong expectedVersion
    await assert.rejects(
      moveFolder({
        folderId: folder.id,
        destination: { type: "global_root" },
        expectedVersion: 888,
        actorId,
      }),
      (err) => {
        assert.ok(err instanceof OrganizationError);
        assert.equal(err.code, "VERSION_CONFLICT");
        return true;
      }
    );
  } finally {
    await db.delete(folders).where(eq(folders.id, folder.id));
  }
});

test("RANDOMIZED: Property-based random tree operations maintain acyclicity and invariants", async () => {
  const db = await getDb();
  const actorId = randomUUID();
  const createdIds = [];

  try {
    // Create a pool of 8 folders with random parent assignments
    for (let i = 0; i < 8; i++) {
      let parentId = null;
      if (createdIds.length > 0 && Math.random() > 0.4) {
        parentId = createdIds[Math.floor(Math.random() * createdIds.length)];
      }
      try {
        const folder = await createFolder({
          name: `Rand-${i}-${randomUUID().slice(0, 4)}`,
          parentId,
          actorId,
        });
        createdIds.push(folder.id);
      } catch (_err) {
        // Depth limit or duplicate can legitimately happen during random generation
      }
    }

    // Perform 15 random move operations
    for (let op = 0; op < 15; op++) {
      if (createdIds.length < 2) break;
      const targetFolderId = createdIds[Math.floor(Math.random() * createdIds.length)];
      const pickParent = Math.random() > 0.3 ? createdIds[Math.floor(Math.random() * createdIds.length)] : null;

      try {
        await moveFolder({
          folderId: targetFolderId,
          destination: pickParent
            ? { type: "folder", folderId: pickParent }
            : { type: "global_root" },
          actorId,
        });
      } catch (err) {
        // Cycles and self-moves must be cleanly caught and rejected
        assert.ok(err instanceof OrganizationError, `Expected OrganizationError but got: ${err}`);
        assert.ok(
          ["CYCLE_DETECTED", "CANNOT_MOVE_INTO_SELF", "EXCEEDS_MAX_DEPTH", "DUPLICATE_FOLDER_NAME"].includes(
            err.code
          ),
          `Unexpected error code: ${err.code} (${err.message})`
        );
      }
    }

    // Authoritative Invariant Verification:
    // Every node in the created set must trace to a root without infinite loop (acyclicity proof)
    const existing = await db
      .select()
      .from(folders)
      .where(inArray(folders.id, createdIds));

    const map = new Map(existing.map((f) => [f.id, f]));

    for (const f of existing) {
      let curr = f;
      const visited = new Set();
      let depth = 0;
      while (curr && curr.parentId) {
        assert.ok(!visited.has(curr.id), `Cycle detected at node ${curr.id}`);
        visited.add(curr.id);
        curr = map.get(curr.parentId);
        depth++;
        assert.ok(depth <= MAX_NESTING_DEPTH, `Depth ${depth} exceeded MAX_NESTING_DEPTH`);
      }
    }
  } finally {
    if (createdIds.length) {
      await db.delete(folders).where(inArray(folders.id, createdIds));
    }
  }
});

test("ADVERSARIAL: Simultaneous opposing moves cannot form a cycle", async () => {
  const db = await getDb();
  const actorId = randomUUID();
  const fA = await createFolder({ name: `A-${randomUUID().slice(0, 6)}`, actorId });
  const fB = await createFolder({ name: `B-${randomUUID().slice(0, 6)}`, actorId });

  try {
    // Tx 1 tries to move A into B, Tx 2 tries to move B into A at the exact same moment
    const results = await Promise.allSettled([
      moveFolder({ folderId: fA.id, destination: { type: "folder", folderId: fB.id }, actorId }),
      moveFolder({ folderId: fB.id, destination: { type: "folder", folderId: fA.id }, actorId }),
    ]);

    // Exactly one move can succeed, and the opposing move must be rejected with CYCLE_DETECTED
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    assert.equal(fulfilled.length, 1, "Exactly one opposing move should succeed");
    assert.equal(rejected.length, 1, "The opposing move must be rejected");
    assert.ok(
      rejected[0].reason instanceof OrganizationError,
      `Expected OrganizationError, got: ${rejected[0].reason}`
    );
    assert.equal(rejected[0].reason.code, "CYCLE_DETECTED");

    // Verify database state: no cycles
    const [rowA] = await db.select().from(folders).where(eq(folders.id, fA.id));
    const [rowB] = await db.select().from(folders).where(eq(folders.id, fB.id));
    assert.ok(
      !(rowA.parentId === fB.id && rowB.parentId === fA.id),
      "Tree must not contain a cycle"
    );
  } finally {
    await db.delete(folders).where(inArray(folders.id, [fA.id, fB.id]));
  }
});

test("ADVERSARIAL: moveGenerations rejects duplicate generation IDs in batch", async () => {
  const gId = randomUUID();
  await assert.rejects(
    moveGenerations({
      ids: [gId, gId],
      destination: { type: "global_unsorted" },
    }),
    (err) => {
      assert.ok(err instanceof OrganizationError);
      assert.equal(err.code, "DUPLICATE_GENERATION_IDS");
      return true;
    }
  );
});

test("ADVERSARIAL: Organization idempotency keys prevent duplicate operations on replay", async () => {
  const db = await getDb();
  const actorId = randomUUID();
  const folder = await createFolder({ name: `Idem-${randomUUID().slice(0, 6)}`, actorId });
  const gId = randomUUID();
  const now = Date.now();

  try {
    await db.insert(generations).values({
      id: gId,
      kind: "image",
      status: "succeeded",
      prompt: "idempotency test",
      model: "flux",
      aspectRatio: "1:1",
      createdAt: now,
      updatedAt: now,
    });

    const idempotencyKey = `test-key-${randomUUID()}`;

    // Pass 1: move generation into folder
    const res1 = await moveGenerations({
      ids: [gId],
      destination: { type: "folder", folderId: folder.id },
      idempotencyKey,
      actorId,
    });
    assert.equal(res1.movedCount, 1);
    assert.equal(res1.folderId, folder.id);

    // Pass 2: Replay identical request with same idempotencyKey
    const res2 = await moveGenerations({
      ids: [gId],
      destination: { type: "folder", folderId: folder.id },
      idempotencyKey,
      actorId,
    });
    // Must return identical cached result without error
    assert.deepEqual(res1, res2);

    const [genRow] = await db.select().from(generations).where(eq(generations.id, gId));
    assert.equal(genRow.locationVersion, 2, "locationVersion must only increment once despite replay");
  } finally {
    await db.delete(generations).where(eq(generations.id, gId));
    await db.delete(folders).where(eq(folders.id, folder.id));
  }
});

test("ADVERSARIAL: Deep subtree move is rejected when targetDepth + subtreeHeight > MAX_NESTING_DEPTH", async () => {
  const db = await getDb();
  const actorId = randomUUID();

  // Temporarily configure a small depth limit for deterministic testing
  const originalLimit = process.env.MAX_NESTING_DEPTH;
  process.env.MAX_NESTING_DEPTH = "3";

  let createdIds = [];
  try {
    // Branch 1: Folder A (depth 1) -> Folder B (depth 2) [subtree height of A is 2]
    const fA = await createFolder({ name: `A-${randomUUID().slice(0, 6)}`, actorId });
    const fB = await createFolder({ name: "B", parentId: fA.id, actorId });

    // Branch 2: Folder C (depth 1) -> Folder D (depth 2)
    const fC = await createFolder({ name: `C-${randomUUID().slice(0, 6)}`, actorId });
    const fD = await createFolder({ name: "D", parentId: fC.id, actorId });

    createdIds = [fA.id, fB.id, fC.id, fD.id];

    // Attempt to move A (subtree height 2) into D (target depth 2).
    // Target depth 2 + subtree height 2 = 4 > MAX_NESTING_DEPTH (3).
    // This MUST reject with EXCEEDS_MAX_DEPTH even though D + 1 <= 3!
    await assert.rejects(
      moveFolder({
        folderId: fA.id,
        destination: { type: "folder", folderId: fD.id },
        actorId,
      }),
      (err) => {
        assert.ok(err instanceof OrganizationError);
        assert.equal(err.code, "EXCEEDS_MAX_DEPTH");
        return true;
      },
      "Subtree move exceeding total depth limit must be rejected"
    );
  } finally {
    process.env.MAX_NESTING_DEPTH = originalLimit;
    if (createdIds.length) {
      await db.delete(folders).where(inArray(folders.id, createdIds));
    }
  }
});
