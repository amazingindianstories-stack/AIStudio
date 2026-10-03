import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { getDb } from "./db.js";
import { renameFolder, deleteFolder, deleteProject } from "./projects-db.js";
import { setItemFolder, upsertItem, completeGenerationItem, getItem } from "./store-db.js";
import { projects, folders, generations } from "./schema.js";
import { eq, sql } from "drizzle-orm";

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

test("REGRESSION: deleteProject refuses deletion when project contains folders or generations", async () => {
  const db = await getDb();
  const pId = randomUUID();
  const fId = randomUUID();
  const gId = randomUUID();
  const now = Date.now();

  try {
    await db.insert(projects).values({ id: pId, name: "Project to test delete", createdAt: now, updatedAt: now });

    // 1. Project with folder must refuse deletion
    await db.insert(folders).values({ id: fId, projectId: pId, name: "Folder inside project", createdAt: now });
    await assert.rejects(
      async () => {
        await deleteProject(pId);
      },
      (err) => {
        assert.equal(err.code, "PROJECT_NOT_EMPTY");
        return true;
      },
      "deleteProject must throw PROJECT_NOT_EMPTY if folders exist"
    );

    // Remove folder, add generation directly in project
    await db.delete(folders).where(eq(folders.id, fId));
    await db.insert(generations).values({
      id: gId,
      kind: "image",
      status: "succeeded",
      prompt: "test in project",
      model: "test-model",
      aspectRatio: "1:1",
      projectId: pId,
      createdAt: now,
      updatedAt: now,
    });

    // 2. Project with generation must refuse deletion
    await assert.rejects(
      async () => {
        await deleteProject(pId);
      },
      (err) => {
        assert.equal(err.code, "PROJECT_NOT_EMPTY");
        return true;
      },
      "deleteProject must throw PROJECT_NOT_EMPTY if generations exist"
    );

    // 3. Once empty, deletion succeeds cleanly
    await db.delete(generations).where(eq(generations.id, gId));
    await deleteProject(pId);

    const [deletedRow] = await db.select().from(projects).where(eq(projects.id, pId));
    assert.equal(deletedRow, undefined, "Empty project should be successfully deleted");
  } finally {
    await db.delete(generations).where(eq(generations.id, gId));
    await db.delete(folders).where(eq(folders.id, fId));
    await db.delete(projects).where(eq(projects.id, pId));
  }
});

test("REGRESSION: upsertItem and completeGenerationItem never overwrite user-moved location on conflict", async () => {
  const db = await getDb();
  const p1Id = randomUUID();
  const p2Id = randomUUID();
  const f1Id = randomUUID();
  const f2Id = randomUUID();
  const gId = randomUUID();
  const now = Date.now();

  try {
    await db.insert(projects).values([
      { id: p1Id, name: "Initial Project", createdAt: now, updatedAt: now },
      { id: p2Id, name: "Moved Project", createdAt: now, updatedAt: now },
    ]);
    await db.insert(folders).values([
      { id: f1Id, projectId: p1Id, name: "Initial Folder", createdAt: now },
      { id: f2Id, projectId: p2Id, name: "Destination Folder", createdAt: now },
    ]);

    // 1. Initial insert of queued item in p1 / f1
    const initialItem = {
      id: gId,
      kind: "video",
      status: "queued",
      prompt: "video prompt",
      model: "seedance",
      aspectRatio: "16:9",
      projectId: p1Id,
      folderId: f1Id,
      locationVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
    await upsertItem(initialItem);

    // 2. User moves generation to p2 / f2 while generation is processing
    await setItemFolder(gId, p2Id, f2Id);
    const moved = await getItem(gId);
    assert.equal(moved.projectId, p2Id);
    assert.equal(moved.folderId, f2Id);
    assert.equal(moved.locationVersion, 2);

    // 3. Provider submission callback / telemetry runs upsertItem with stale in-memory record (pointing to p1 / f1)
    const staleInMemorySubmission = {
      ...initialItem,
      status: "running",
      taskId: "task-byteplus-12345",
      updatedAt: now + 1000,
    };
    await upsertItem(staleInMemorySubmission);

    // Verify location was NOT overwritten back to p1 / f1!
    const afterSubmissionUpsert = await getItem(gId);
    assert.equal(afterSubmissionUpsert.status, "running");
    assert.equal(afterSubmissionUpsert.taskId, "task-byteplus-12345");
    assert.equal(afterSubmissionUpsert.projectId, p2Id, "projectId must stay at moved destination");
    assert.equal(afterSubmissionUpsert.folderId, f2Id, "folderId must stay at moved destination");
    assert.equal(afterSubmissionUpsert.locationVersion, 2, "locationVersion must remain 2");

    // 4. Provider completion runs completeGenerationItem with stale record
    await completeGenerationItem({
      id: gId,
      status: "succeeded",
      url: "https://example.com/video.mp4",
      aspectRatio: "16:9",
      projectId: p1Id, // Stale in-memory record
      folderId: f1Id,
      locationVersion: 1,
      completedAt: now + 5000,
    });

    const finalItem = await getItem(gId);
    assert.equal(finalItem.status, "succeeded");
    assert.equal(finalItem.url, "https://example.com/video.mp4");
    assert.equal(finalItem.projectId, p2Id, "completeGenerationItem must not overwrite projectId");
    assert.equal(finalItem.folderId, f2Id, "completeGenerationItem must not overwrite folderId");
    assert.equal(finalItem.locationVersion, 2);
  } finally {
    await db.delete(generations).where(eq(generations.id, gId));
    await db.delete(folders).where(eq(folders.id, f1Id));
    await db.delete(folders).where(eq(folders.id, f2Id));
    await db.delete(projects).where(eq(projects.id, p1Id));
    await db.delete(projects).where(eq(projects.id, p2Id));
  }
});

test("REGRESSION: Database scope integrity triggers prevent direct SQL violations", async () => {
  const db = await getDb();
  const p1Id = randomUUID();
  const p2Id = randomUUID();
  const f1Id = randomUUID();
  const f2Id = randomUUID();
  const genId = randomUUID();
  const now = Date.now();

  try {
    await db.insert(projects).values([
      { id: p1Id, name: "Project 1", createdAt: now, updatedAt: now },
      { id: p2Id, name: "Project 2", createdAt: now, updatedAt: now },
    ]);
    await db.insert(folders).values({
      id: f1Id,
      projectId: p1Id,
      name: "Parent In P1",
      createdAt: now,
    });

    // 1. Direct SQL attempting to create child folder with p2 under parent with p1
    await assert.rejects(
      async () => {
        await db.execute(sql`
          INSERT INTO folders (id, project_id, parent_id, name, created_at, updated_at)
          VALUES (${f2Id}::uuid, ${p2Id}::uuid, ${f1Id}::uuid, 'Illegal Child', ${now}, ${now})
        `);
      },
      (err) => {
        const fullMsg = `${err?.message || ""} ${err?.cause?.message || ""}`;
        return /Folder scope mismatch|check_folder_scope|scope integrity/i.test(fullMsg);
      },
      "Trigger trg_check_folder_scope must reject child with different project_id than parent"
    );

    // 2. Direct SQL attempting to create generation with p2 in folder belonging to p1
    await assert.rejects(
      async () => {
        await db.execute(sql`
          INSERT INTO generations (id, kind, status, prompt, model, aspect_ratio, project_id, folder_id, created_at, updated_at)
          VALUES (${genId}::uuid, 'image', 'succeeded', 'Illegal Child Gen', 'flux', '1:1', ${p2Id}::uuid, ${f1Id}::uuid, ${now}, ${now})
        `);
      },
      (err) => {
        const fullMsg = `${err?.message || ""} ${err?.cause?.message || ""}`;
        return /Generation scope mismatch|check_generation_scope|scope integrity/i.test(fullMsg);
      },
      "Trigger trg_check_generation_scope must reject generation with different project_id than folder"
    );

    // 3. Direct SQL attempting to insert folder with unknown project_id
    const unknownProjId = randomUUID();
    await assert.rejects(
      async () => {
        await db.execute(sql`
          INSERT INTO folders (id, project_id, name, created_at, updated_at)
          VALUES (${randomUUID()}::uuid, ${unknownProjId}::uuid, 'Unknown Project Child', ${now}, ${now})
        `);
      },
      (err) => {
        const fullMsg = `${err?.message || ""} ${err?.cause?.message || ""}`;
        return /folders_project_id_fkey|foreign key/i.test(fullMsg);
      },
      "Must reject folder with unknown project_id via foreign key"
    );

    // 4. Direct SQL attempting to insert folder with unknown parent_id
    const unknownParentId = randomUUID();
    await assert.rejects(
      async () => {
        await db.execute(sql`
          INSERT INTO folders (id, project_id, parent_id, name, created_at, updated_at)
          VALUES (${randomUUID()}::uuid, ${p1Id}::uuid, ${unknownParentId}::uuid, 'Unknown Parent Child', ${now}, ${now})
        `);
      },
      (err) => {
        const fullMsg = `${err?.message || ""} ${err?.cause?.message || ""}`;
        return /folders_parent_id_fkey|Parent folder.*does not exist|foreign key/i.test(fullMsg);
      },
      "Must reject folder with unknown parent_id via foreign key or trigger"
    );

    // 5. Direct SQL attempting to insert generation with unknown project_id
    await assert.rejects(
      async () => {
        await db.execute(sql`
          INSERT INTO generations (id, kind, status, prompt, model, aspect_ratio, project_id, created_at, updated_at)
          VALUES (${randomUUID()}::uuid, 'image', 'succeeded', 'Unknown Proj Gen', 'flux', '1:1', ${unknownProjId}::uuid, ${now}, ${now})
        `);
      },
      (err) => {
        const fullMsg = `${err?.message || ""} ${err?.cause?.message || ""}`;
        return /generations_project_id_fkey|foreign key/i.test(fullMsg);
      },
      "Must reject generation with unknown project_id via foreign key"
    );

    // 6. Direct SQL attempting to insert generation with unknown folder_id
    await assert.rejects(
      async () => {
        await db.execute(sql`
          INSERT INTO generations (id, kind, status, prompt, model, aspect_ratio, project_id, folder_id, created_at, updated_at)
          VALUES (${randomUUID()}::uuid, 'image', 'succeeded', 'Unknown Folder Gen', 'flux', '1:1', ${p1Id}::uuid, ${unknownParentId}::uuid, ${now}, ${now})
        `);
      },
      (err) => {
        const fullMsg = `${err?.message || ""} ${err?.cause?.message || ""}`;
        return /generations_folder_id_fkey|Referenced folder.*does not exist|foreign key/i.test(fullMsg);
      },
      "Must reject generation with unknown folder_id via foreign key or trigger"
    );

    // 7. Direct SQL parent-scope mutation: updating parent folder project_id directly must reject when it leaves child folders or generations mismatched
    // Seed valid child folder and valid generation under f1Id in p1Id
    await db.insert(folders).values({
      id: f2Id,
      projectId: p1Id,
      parentId: f1Id,
      name: "Valid Child Under F1",
      createdAt: now,
    });
    await db.insert(generations).values({
      id: genId,
      projectId: p1Id,
      folderId: f1Id,
      prompt: "Valid Gen in F1",
      kind: "image",
      status: "succeeded",
      model: "flux",
      aspectRatio: "1:1",
      createdAt: now,
      updatedAt: now,
    });

    await assert.rejects(
      async () => {
        await db.execute(sql`
          UPDATE folders SET project_id = ${p2Id}::uuid WHERE id = ${f1Id}::uuid
        `);
      },
      (err) => {
        const fullMsg = `${err?.message || ""} ${err?.cause?.message || ""}`;
        return /Folder scope mismatch|Generation scope mismatch|scope integrity/i.test(fullMsg);
      },
      "Updating parent folder project_id directly must reject when leaving child folders or generations mismatched"
    );

    // 8. Direct SQL folder deletion must be rejected by RESTRICT foreign keys when it has child folders or generations
    await assert.rejects(
      async () => {
        await db.execute(sql`
          DELETE FROM folders WHERE id = ${f1Id}::uuid
        `);
      },
      (err) => {
        const fullMsg = `${err?.message || ""} ${err?.cause?.message || ""}`;
        return /folders_parent_id_fkey|generations_folder_id_fkey|foreign key/i.test(fullMsg);
      },
      "Deleting parent folder directly must be rejected by RESTRICT when it has child folders or generations"
    );

    // 9. Transaction rollback preserves state on failed scope mutation
    const rollbackFolderId = randomUUID();
    let txFailed = false;
    try {
      await db.transaction(async (tx) => {
        await tx.insert(folders).values({
          id: rollbackFolderId,
          projectId: p1Id,
          name: "Rollback Candidate",
          createdAt: now,
        });
        // Intentionally violate scope inside the transaction
        await tx.execute(sql`
          INSERT INTO folders (id, project_id, parent_id, name, created_at, updated_at)
          VALUES (${randomUUID()}::uuid, ${p2Id}::uuid, ${rollbackFolderId}::uuid, 'Mismatched Child', ${now}, ${now})
        `);
      });
    } catch {
      txFailed = true;
    }
    assert.equal(txFailed, true, "Transaction must fail and roll back");
    const [survivingFolder] = await db.select().from(folders).where(eq(folders.id, rollbackFolderId));
    assert.equal(survivingFolder, undefined, "Rollback candidate folder must not persist after aborted transaction");
  } finally {
    await db.delete(generations).where(eq(generations.id, genId));
    await db.delete(folders).where(eq(folders.id, f2Id));
    await db.delete(folders).where(eq(folders.id, f1Id));
    await db.delete(projects).where(eq(projects.id, p1Id));
    await db.delete(projects).where(eq(projects.id, p2Id));
  }
});
