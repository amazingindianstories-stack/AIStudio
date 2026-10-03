import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { getDb } from "./db.js";
import { projects, folders, activityLogs } from "./schema.js";
import {
  createFolder,
  renameFolder,
  deleteFolder,
  moveFolder,
  OrganizationError,
} from "./folder-engine.js";
import { deleteProject } from "./projects-db.js";

test("AUDIT TRUTHFULNESS: Successful organization events commit atomically with mutations", async () => {
  const db = await getDb();
  const actorId = randomUUID();

  // 1. Create folder
  const folder = await createFolder({
    name: `AuditSuccess-${randomUUID().slice(0, 6)}`,
    actorId,
  });
  assert.ok(folder.id);

  const [createLog] = await db
    .select()
    .from(activityLogs)
    .where(
      and(
        eq(activityLogs.userId, actorId),
        eq(activityLogs.action, "create_folder")
      )
    );
  assert.ok(createLog, "create_folder activity log must be committed");
  assert.equal(createLog.detail.folderId, folder.id);

  // 2. Rename folder
  await renameFolder({
    folderId: folder.id,
    name: `AuditRenamed-${randomUUID().slice(0, 6)}`,
    actorId,
  });

  const [renameLog] = await db
    .select()
    .from(activityLogs)
    .where(
      and(
        eq(activityLogs.userId, actorId),
        eq(activityLogs.action, "rename_folder")
      )
    );
  assert.ok(renameLog, "rename_folder activity log must be committed");
  assert.equal(renameLog.detail.folderId, folder.id);

  // 3. Move folder
  await moveFolder({
    folderId: folder.id,
    destination: { type: "global_root" },
    actorId,
  });

  const [moveLog] = await db
    .select()
    .from(activityLogs)
    .where(
      and(
        eq(activityLogs.userId, actorId),
        eq(activityLogs.action, "move_folder")
      )
    );
  assert.ok(moveLog, "move_folder activity log must be committed");
  assert.equal(moveLog.detail.folderId, folder.id);

  // 4. Delete folder
  await deleteFolder({
    folderId: folder.id,
    actorId,
  });

  const [deleteLog] = await db
    .select()
    .from(activityLogs)
    .where(
      and(
        eq(activityLogs.userId, actorId),
        eq(activityLogs.action, "delete_folder")
      )
    );
  assert.ok(deleteLog, "delete_folder activity log must be committed");
  assert.equal(deleteLog.detail.folderId, folder.id);
});

test("AUDIT TRUTHFULNESS: Failed or rejected project deletion emits ZERO audit logs", async () => {
  const db = await getDb();
  const actorId = randomUUID();
  const now = Date.now();
  const projId = randomUUID();

  // Create project with a folder
  await db.insert(projects).values({
    id: projId,
    name: "Non-empty Project",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(folders).values({
    id: randomUUID(),
    name: "Blocking Folder",
    nameNormalized: "blocking folder",
    projectId: projId,
    version: 1,
    createdAt: now,
    updatedAt: now,
  });

  // Attempt deleteProject — must be rejected with PROJECT_NOT_EMPTY
  await assert.rejects(
    async () => {
      await deleteProject(projId, actorId);
    },
    (err) => {
      assert.equal(err.code, "PROJECT_NOT_EMPTY");
      return true;
    }
  );

  // Assert ZERO delete_project audit logs exist for this actor and project!
  const logs = await db
    .select()
    .from(activityLogs)
    .where(
      and(
        eq(activityLogs.userId, actorId),
        eq(activityLogs.action, "delete_project")
      )
    );
  assert.equal(logs.length, 0, "No audit log must be emitted when project deletion is rejected");
});

test("AUDIT TRUTHFULNESS: Failed or rejected folder deletion emits ZERO audit logs", async () => {
  const db = await getDb();
  const actorId = randomUUID();

  // Parent with a child folder
  const parent = await createFolder({
    name: `Parent-${randomUUID().slice(0, 6)}`,
    actorId,
  });
  await createFolder({
    name: `Child-${randomUUID().slice(0, 6)}`,
    parentId: parent.id,
    actorId,
  });

  // Attempt deleting parent — must be rejected with FOLDER_NOT_EMPTY
  await assert.rejects(
    async () => {
      await deleteFolder({
        folderId: parent.id,
        actorId,
      });
    },
    (err) => {
      assert.ok(err instanceof OrganizationError);
      assert.equal(err.code, "FOLDER_NOT_EMPTY");
      return true;
    }
  );

  // Assert ZERO delete_folder audit logs exist for parent.id
  const deleteLogs = await db
    .select()
    .from(activityLogs)
    .where(
      and(
        eq(activityLogs.userId, actorId),
        eq(activityLogs.action, "delete_folder")
      )
    );
  const matching = deleteLogs.filter((l) => l.detail?.folderId === parent.id);
  assert.equal(matching.length, 0, "No delete_folder audit log must be emitted when folder deletion is rejected");
});

test("AUDIT TRUTHFULNESS: Transaction rollback leaves ZERO audit logs", async () => {
  const db = await getDb();
  const actorId = randomUUID();

  // Transaction that inserts folder, calls logActivity, then rolls back
  try {
    await db.transaction(async (tx) => {
      await createFolder({
        name: `RollbackFolder-${randomUUID().slice(0, 6)}`,
        actorId,
        tx,
      });
      // Force rollback
      throw new Error("INJECTED_ROLLBACK");
    });
  } catch (err) {
    assert.equal(err.message, "INJECTED_ROLLBACK");
  }

  // Assert ZERO activity logs exist for this actor
  const logs = await db
    .select()
    .from(activityLogs)
    .where(eq(activityLogs.userId, actorId));
  assert.equal(logs.length, 0, "All audit records must roll back atomically when transaction fails");
});

test("AUDIT TRUTHFULNESS: Idempotency replay does NOT duplicate audit records", async () => {
  const db = await getDb();
  const actorId = randomUUID();
  const key = `audit-idem-${randomUUID()}`;
  const folderName = `IdemAudit-${randomUUID().slice(0, 6)}`;

  // Call 1
  const res1 = await createFolder({
    name: folderName,
    actorId,
    idempotencyKey: key,
  });

  // Call 2 (replay)
  const res2 = await createFolder({
    name: folderName,
    actorId,
    idempotencyKey: key,
  });

  assert.equal(res1.id, res2.id);

  // Assert EXACTLY ONE activity log was created for this folder
  const logs = await db
    .select()
    .from(activityLogs)
    .where(
      and(
        eq(activityLogs.userId, actorId),
        eq(activityLogs.action, "create_folder")
      )
    );
  const matching = logs.filter((l) => l.detail?.folderId === res1.id);
  assert.equal(matching.length, 1, "Idempotent replay must not emit duplicate activity logs");
});
