import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "./db.js";
import { projects, folders, generations } from "./schema.js";
import { HIERARCHICAL_FOLDER_STATEMENTS } from "../../scripts/migrate-hierarchical-folders.js";
import { auditFolderMigration } from "../../scripts/audit-folder-migration.js";
import { createFolder, moveGenerations } from "./folder-engine.js";

test("Additive schema migration preserves legacy records and is strictly idempotent", async () => {
  assert.ok(process.env.DATABASE_URL, "test:db requires a disposable PostgreSQL database");
  const db = await getDb();

  const pId = randomUUID();
  const f1Id = randomUUID();
  const f2Id = randomUUID();
  const g1Id = randomUUID();
  const g2Id = randomUUID();
  const g3Id = randomUUID();
  const now = Date.now();

  try {
    // 1. Insert representative legacy records
    await db.insert(projects).values({
      id: pId,
      name: "Legacy Project",
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(folders).values([
      { id: f1Id, projectId: pId, name: "Legacy Folder 1", createdAt: now },
      { id: f2Id, projectId: pId, name: "Legacy Folder 2", createdAt: now },
    ]);

    await db.insert(generations).values([
      // Generation in folder
      {
        id: g1Id,
        kind: "image",
        status: "succeeded",
        prompt: "Legacy gen in folder",
        model: "legacy-model",
        aspectRatio: "1:1",
        projectId: pId,
        folderId: f1Id,
        createdAt: now,
        updatedAt: now,
      },
      // Generation in project unsorted
      {
        id: g2Id,
        kind: "image",
        status: "succeeded",
        prompt: "Legacy gen in project unsorted",
        model: "legacy-model",
        aspectRatio: "1:1",
        projectId: pId,
        folderId: null,
        createdAt: now,
        updatedAt: now,
      },
      // Generation in global unsorted
      {
        id: g3Id,
        kind: "image",
        status: "succeeded",
        prompt: "Legacy gen in global unsorted",
        model: "legacy-model",
        aspectRatio: "1:1",
        projectId: null,
        folderId: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    // 2. Preflight audit
    const auditReport = await auditFolderMigration();
    assert.ok(auditReport.projectsCount >= 1);
    assert.ok(auditReport.foldersCount >= 2);
    assert.ok(auditReport.generationsCount >= 3);
    assert.equal(auditReport.orphanedFolderGenerations.length, 0);
    assert.equal(auditReport.inconsistentGenerations.length, 0);

    // 3. Apply migration statements (idempotent pass 1)
    for (const stmt of HIERARCHICAL_FOLDER_STATEMENTS) {
      await db.execute(sql.raw(stmt));
    }

    // 4. Verify existing identities and scopes survived
    const [rowF1] = await db.select().from(folders).where(sql`id = ${f1Id}::uuid`);
    assert.ok(rowF1);
    assert.equal(rowF1.name, "Legacy Folder 1");
    assert.equal(rowF1.nameNormalized, "legacy folder 1");
    assert.equal(rowF1.projectId, pId);
    assert.equal(rowF1.parentId, null);

    const [rowG1] = await db.select().from(generations).where(sql`id = ${g1Id}::uuid`);
    assert.ok(rowG1);
    assert.equal(rowG1.projectId, pId);
    assert.equal(rowG1.folderId, f1Id);
    assert.equal(rowG1.locationVersion, 1);

    const [rowG2] = await db.select().from(generations).where(sql`id = ${g2Id}::uuid`);
    assert.ok(rowG2);
    assert.equal(rowG2.projectId, pId);
    assert.equal(rowG2.folderId, null);

    const [rowG3] = await db.select().from(generations).where(sql`id = ${g3Id}::uuid`);
    assert.ok(rowG3);
    assert.equal(rowG3.projectId, null);
    assert.equal(rowG3.folderId, null);

    // 5. Test new functionality: Global folder creation
    const globalFolder = await createFolder({
      name: "Global Root Folder",
      projectId: null,
      parentId: null,
    });
    assert.ok(globalFolder.id);
    assert.equal(globalFolder.projectId, null);
    assert.equal(globalFolder.parentId, null);

    // 6. Test new functionality: Subfolder creation
    const subfolder = await createFolder({
      name: "Subfolder Under Legacy",
      projectId: null, // should inherit pId from parent
      parentId: f1Id,
    });
    assert.ok(subfolder.id);
    assert.equal(subfolder.projectId, pId);
    assert.equal(subfolder.parentId, f1Id);

    // 7. Test new functionality: Move global unsorted item into subfolder
    await moveGenerations({
      ids: [g3Id],
      destination: { type: "folder", folderId: subfolder.id },
    });
    const [movedG3] = await db.select().from(generations).where(sql`id = ${g3Id}::uuid`);
    assert.equal(movedG3.folderId, subfolder.id);
    assert.equal(movedG3.projectId, pId); // scope reconciled to project!

    // 8. Test migration idempotency (idempotent pass 2)
    for (const stmt of HIERARCHICAL_FOLDER_STATEMENTS) {
      await db.execute(sql.raw(stmt));
    }
    // Verify records remain intact after second run
    const [rowF1SecondPass] = await db.select().from(folders).where(sql`id = ${f1Id}::uuid`);
    assert.equal(rowF1SecondPass.nameNormalized, "legacy folder 1");

    // Clean up created new folders
    await db.delete(generations).where(sql`id = ${g3Id}::uuid`);
    await db.delete(folders).where(sql`id = ${subfolder.id}::uuid`);
    await db.delete(folders).where(sql`id = ${globalFolder.id}::uuid`);
  } finally {
    await db.delete(generations).where(sql`id IN (${g1Id}::uuid, ${g2Id}::uuid, ${g3Id}::uuid)`);
    await db.delete(folders).where(sql`id IN (${f1Id}::uuid, ${f2Id}::uuid)`);
    await db.delete(projects).where(sql`id = ${pId}::uuid`);
  }
});
