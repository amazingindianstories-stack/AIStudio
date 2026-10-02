import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { getDb } from "./db.js";
import { renameFolder, deleteFolder } from "./projects-db.js";
import { setItemFolder } from "./store-db.js";
import { eq } from "drizzle-orm";

test("REGRESSION: renameFolder must reject mismatched projectId", async () => {
  const db = await getDb();
  const p1Id = randomUUID();
  const p2Id = randomUUID();
  const fId = randomUUID();
  const now = Date.now();

  try {
    await db.insert(projects).values([
      { id: p1Id, name: "Project 1", createdAt: now, updatedAt: now },
      { id: p2Id, name: "Project 2", createdAt: now, updatedAt: now },
    ]);
    await db.insert(folders).values({
      id: fId,
      projectId: p1Id,
      name: "Original Folder",
      createdAt: now,
    });

    // Attempt to rename folder in p1 by pretending it belongs to p2
    await assert.rejects(
      async () => {
        await renameFolder(p2Id, fId, "Renamed By Attacker");
      },
      /mismatch|not found|unauthorized|invalid/i,
      "renameFolder should reject when projectId does not match folder's actual project"
    );

    // Verify folder name was NOT changed
    const [row] = await db.select().from(folders).where(eq(folders.id, fId));
    assert.equal(row.name, "Original Folder");
  } finally {
    await db.delete(folders).where(eq(folders.id, fId));
    await db.delete(projects).where(eq(projects.id, p1Id));
    await db.delete(projects).where(eq(projects.id, p2Id));
  }
});

test("REGRESSION: deleteFolder must reject mismatched projectId", async () => {
  const db = await getDb();
  const p1Id = randomUUID();
  const p2Id = randomUUID();
  const fId = randomUUID();
  const now = Date.now();

  try {
    await db.insert(projects).values([
      { id: p1Id, name: "Project 1", createdAt: now, updatedAt: now },
      { id: p2Id, name: "Project 2", createdAt: now, updatedAt: now },
    ]);
    await db.insert(folders).values({
      id: fId,
      projectId: p1Id,
      name: "Folder In P1",
      createdAt: now,
    });

    await assert.rejects(
      async () => {
        await deleteFolder(p2Id, fId);
      },
      /mismatch|not found|unauthorized|invalid/i,
      "deleteFolder should reject when projectId does not match folder's actual project"
    );

    const [row] = await db.select().from(folders).where(eq(folders.id, fId));
    assert.ok(row, "Folder should still exist after rejected deletion");
  } finally {
    await db.delete(folders).where(eq(folders.id, fId));
    await db.delete(projects).where(eq(projects.id, p1Id));
    await db.delete(projects).where(eq(projects.id, p2Id));
  }
});

test("REGRESSION: setItemFolder must reject mismatched destination project and folder scope", async () => {
  const db = await getDb();
  const p1Id = randomUUID();
  const p2Id = randomUUID();
  const fId = randomUUID();
  const genId = randomUUID();
  const now = Date.now();

  try {
    await db.insert(projects).values([
      { id: p1Id, name: "Project 1", createdAt: now, updatedAt: now },
      { id: p2Id, name: "Project 2", createdAt: now, updatedAt: now },
    ]);
    await db.insert(folders).values({
      id: fId,
      projectId: p1Id,
      name: "Folder In P1",
      createdAt: now,
    });
    await db.insert(generations).values({
      id: genId,
      kind: "image",
      status: "succeeded",
      prompt: "test",
      model: "test-model",
      aspectRatio: "1:1",
      createdAt: now,
      updatedAt: now,
    });

    // Attempt to set item folder to fId (in p1) while claiming projectId is p2
    await assert.rejects(
      async () => {
        await setItemFolder(genId, p2Id, fId);
      },
      /mismatch|invalid|inconsistent/i,
      "setItemFolder should reject when folder belongs to a different project than specified"
    );
  } finally {
    await db.delete(generations).where(eq(generations.id, genId));
    await db.delete(folders).where(eq(folders.id, fId));
    await db.delete(projects).where(eq(projects.id, p1Id));
    await db.delete(projects).where(eq(projects.id, p2Id));
  }
});
