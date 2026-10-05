import test from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { inArray, eq } from "drizzle-orm";
import { getDb } from "./db.js";
import {
  folders,
  generations,
  generationNaming,
  mediaExports,
  mediaExportItems,
} from "./schema.js";
import { batchResolveGenerationFilenames } from "./filename-resolver.js";
import {
  createMediaExport,
  appendMediaExportItems,
  finalizeMediaExport,
} from "./media-exports-db.js";

test("Compact naming rejects ZIP collisions with Café and Cafe without decorating downloads", async () => {
  const db = await getDb();
  const f1Id = randomUUID();
  const f2Id = randomUUID();
  const f3Id = randomUUID();

  const g1Id = randomUUID();
  const g2Id = randomUUID();
  const g3Id = randomUUID();

  await db.delete(generationNaming).where(inArray(generationNaming.generationId, [g1Id, g2Id, g3Id])).catch(() => {});
  await db.delete(generations).where(inArray(generations.id, [g1Id, g2Id, g3Id])).catch(() => {});
  await db.delete(folders).where(inArray(folders.id, [f1Id, f2Id, f3Id])).catch(() => {});

  const now = Date.now();
  await db.insert(folders).values([
    { id: f1Id, name: "Café", nameNormalized: "cafe", version: 1, createdAt: now, updatedAt: now },
    { id: f2Id, name: "Cafe", nameNormalized: "cafe", version: 1, createdAt: now, updatedAt: now },
    { id: f3Id, name: "cafe_aaaa", nameNormalized: "cafe_aaaa", version: 1, createdAt: now, updatedAt: now },
  ]);

  await db.insert(generations).values([
    { id: g1Id, kind: "image", status: "completed", prompt: "p1", model: "m", aspectRatio: "1:1", folderId: f1Id, url: "https://storage.googleapis.com/b/g1.png", createdAt: now, updatedAt: now },
    { id: g2Id, kind: "image", status: "completed", prompt: "p2", model: "m", aspectRatio: "1:1", folderId: f2Id, url: "https://storage.googleapis.com/b/g2.png", createdAt: now, updatedAt: now },
    { id: g3Id, kind: "image", status: "completed", prompt: "p3", model: "m", aspectRatio: "1:1", folderId: f3Id, url: "https://storage.googleapis.com/b/g3.png", createdAt: now, updatedAt: now },
  ]);

  try {
    const map = await batchResolveGenerationFilenames(db, [g1Id, g2Id, g3Id]);
    const fn1 = map.get(g1Id)?.filename;
    const fn2 = map.get(g2Id)?.filename;
    const fn3 = map.get(g3Id)?.filename;

    // Requirement: No secondary collision! fn1 and fn3 must NOT collide!
    assert.notEqual(
      fn1,
      fn3,
      `Secondary collision detected: Folder Café and folder cafe_aaaa both resolved to '${fn1}'`
    );
    assert.equal(fn1, fn2, "Compact names omit internal namespace IDs");
    assert.notEqual(fn2, fn3, "Cafe and cafe_aaaa must not collide");
    const ownerId = randomUUID();
    const exp = await createMediaExport(ownerId, now);
    try {
      await appendMediaExportItems(exp.id, ownerId, [g1Id, g2Id], now);
      await assert.rejects(finalizeMediaExport(exp.id, ownerId, now), /EXPORT_FILENAME_COLLISION/);
      const [row] = await db.select().from(mediaExports).where(eq(mediaExports.id, exp.id));
      assert.equal(row.status, "draft", "Duplicate names must never reach the ZIP worker");
    } finally {
      await db.delete(mediaExportItems).where(eq(mediaExportItems.exportId, exp.id));
      await db.delete(mediaExports).where(eq(mediaExports.id, exp.id));
    }
  } finally {
    await db.delete(generationNaming).where(inArray(generationNaming.generationId, [g1Id, g2Id, g3Id])).catch(() => {});
    await db.delete(generations).where(inArray(generations.id, [g1Id, g2Id, g3Id])).catch(() => {});
    await db.delete(folders).where(inArray(folders.id, [f1Id, f2Id, f3Id])).catch(() => {});
  }
});

test("RED Test 2: Unrelated folder creation must not retroactively rename existing generations", async () => {
  const db = await getDb();
  const f1Id = randomUUID();
  const f2Id = randomUUID();
  const g1Id = randomUUID();

  await db.delete(generationNaming).where(inArray(generationNaming.generationId, [g1Id])).catch(() => {});
  await db.delete(generations).where(inArray(generations.id, [g1Id])).catch(() => {});
  await db.delete(folders).where(inArray(folders.id, [f1Id, f2Id])).catch(() => {});

  const now = Date.now();
  await db.insert(folders).values([
    { id: f1Id, name: "Portfolio", nameNormalized: "portfolio", version: 1, createdAt: now, updatedAt: now },
  ]);
  await db.insert(generations).values([
    { id: g1Id, kind: "image", status: "completed", prompt: "p", model: "m", aspectRatio: "1:1", folderId: f1Id, url: "https://storage.googleapis.com/b/g1.png", createdAt: now, updatedAt: now },
  ]);

  try {
    const map1 = await batchResolveGenerationFilenames(db, [g1Id]);
    const fnBefore = map1.get(g1Id)?.filename;

    // Later, an unrelated folder with a colliding slug is created elsewhere
    await db.insert(folders).values([
      { id: f2Id, name: "Portfólio", nameNormalized: "portfolio", version: 1, createdAt: now + 100, updatedAt: now + 100 },
    ]);

    const map2 = await batchResolveGenerationFilenames(db, [g1Id]);
    const fnAfter = map2.get(g1Id)?.filename;

    // Requirement: Original generation filename must NOT change due to unrelated creation!
    assert.equal(
      fnAfter,
      fnBefore,
      `Retroactive rename bug: Filename changed from '${fnBefore}' to '${fnAfter}' after unrelated folder creation`
    );
  } finally {
    await db.delete(generationNaming).where(inArray(generationNaming.generationId, [g1Id])).catch(() => {});
    await db.delete(generations).where(inArray(generations.id, [g1Id])).catch(() => {});
    await db.delete(folders).where(inArray(folders.id, [f1Id, f2Id])).catch(() => {});
  }
});

test("RED Test 3: Truncation hash collision & ZIP silent rename position suffix", async () => {
  const db = await getDb();
  const f1Id = randomUUID();
  const f2Id = randomUUID();
  const g1Id = randomUUID();
  const g2Id = randomUUID();
  const userId = randomUUID();

  const p1 = "long".repeat(62) + "_505";
  const p2 = "long".repeat(62) + "_4265";

  await db.delete(generationNaming).where(inArray(generationNaming.generationId, [g1Id, g2Id])).catch(() => {});
  await db.delete(generations).where(inArray(generations.id, [g1Id, g2Id])).catch(() => {});
  await db.delete(folders).where(inArray(folders.id, [f1Id, f2Id])).catch(() => {});

  const now = Date.now();
  await db.insert(folders).values([
    { id: f1Id, name: p1, nameNormalized: p1, version: 1, createdAt: now, updatedAt: now },
    { id: f2Id, name: p2, nameNormalized: p2, version: 1, createdAt: now, updatedAt: now },
  ]);
  await db.insert(generations).values([
    { id: g1Id, kind: "image", status: "completed", prompt: "p", model: "m", aspectRatio: "1:1", folderId: f1Id, url: "https://storage.googleapis.com/b/g1.png", createdAt: now, updatedAt: now },
    { id: g2Id, kind: "image", status: "completed", prompt: "p", model: "m", aspectRatio: "1:1", folderId: f2Id, url: "https://storage.googleapis.com/b/g2.png", createdAt: now, updatedAt: now },
  ]);

  try {
    const map = await batchResolveGenerationFilenames(db, [g1Id, g2Id]);
    const fn1 = map.get(g1Id)?.filename;
    const fn2 = map.get(g2Id)?.filename;

    // Requirement 1: Unique filenames in resolver
    assert.notEqual(fn1, fn2, `Truncation hash collision: distinct paths resolved to identical filename '${fn1}'`);

    // Requirement 2: Max 255 UTF-8 bytes
    assert.ok(Buffer.byteLength(fn1, "utf8") <= 255);
    assert.ok(Buffer.byteLength(fn2, "utf8") <= 255);

    // Requirement 3: ZIP manifest must use exact canonical filenames, NOT silently rename with _position
    const exp = await createMediaExport(userId, now);
    await appendMediaExportItems(exp.id, userId, [g1Id, g2Id], now);
    await finalizeMediaExport(exp.id, userId, now);

    const items = await db.select().from(mediaExportItems).where(eq(mediaExportItems.exportId, exp.id)).orderBy(mediaExportItems.position);
    assert.equal(items[0].filename, fn1, "ZIP item 1 must match direct download filename exactly");
    assert.equal(items[1].filename, fn2, "ZIP item 2 must match direct download filename exactly, no position suffix");

    await db.delete(mediaExportItems).where(eq(mediaExportItems.exportId, exp.id));
    await db.delete(mediaExports).where(eq(mediaExports.id, exp.id));
  } finally {
    await db.delete(generationNaming).where(inArray(generationNaming.generationId, [g1Id, g2Id])).catch(() => {});
    await db.delete(generations).where(inArray(generations.id, [g1Id, g2Id])).catch(() => {});
    await db.delete(folders).where(inArray(folders.id, [f1Id, f2Id])).catch(() => {});
  }
});

test("RED Test 4: Finalized export retry must preserve frozen filenames across folder rename", async () => {
  const db = await getDb();
  const fId = randomUUID();
  const gId = randomUUID();
  const userId = randomUUID();

  await db.delete(mediaExportItems).where(eq(mediaExportItems.generationId, gId)).catch(() => {});
  await db.delete(generationNaming).where(eq(generationNaming.generationId, gId)).catch(() => {});
  await db.delete(generations).where(inArray(generations.id, [gId])).catch(() => {});
  await db.delete(folders).where(inArray(folders.id, [fId])).catch(() => {});

  const now = Date.now();
  await db.insert(folders).values([
    { id: fId, name: "InitialFolder", nameNormalized: "initialfolder", version: 1, createdAt: now, updatedAt: now },
  ]);
  await db.insert(generations).values([
    { id: gId, kind: "image", status: "completed", prompt: "p", model: "m", aspectRatio: "1:1", folderId: fId, url: "https://storage.googleapis.com/b/g.png", createdAt: now, updatedAt: now },
  ]);

  const exp = await createMediaExport(userId, now);
  await appendMediaExportItems(exp.id, userId, [gId], now);
  await finalizeMediaExport(exp.id, userId, now);

  const [itemBefore] = await db.select().from(mediaExportItems).where(eq(mediaExportItems.exportId, exp.id));
  const frozenFilename = itemBefore.filename;

  try {
    // Fail the export
    await db.update(mediaExports).set({ status: "failed", error: "Worker crash" }).where(eq(mediaExports.id, exp.id));

    // Rename folder while export is failed
    await db.update(folders).set({ name: "RenamedFolder", nameNormalized: "renamedfolder" }).where(eq(folders.id, fId));

    // Retry export via finalizeMediaExport
    await finalizeMediaExport(exp.id, userId, now + 100);

    const [itemAfter] = await db.select().from(mediaExportItems).where(eq(mediaExportItems.exportId, exp.id));

    // Requirement: Frozen filenames MUST NOT CHANGE upon retry of an already-finalized export!
    assert.equal(
      itemAfter.filename,
      frozenFilename,
      `Frozen manifest violated: Filename changed from '${frozenFilename}' to '${itemAfter.filename}' on retry`
    );
  } finally {
    await db.delete(mediaExportItems).where(eq(mediaExportItems.exportId, exp.id));
    await db.delete(mediaExports).where(eq(mediaExports.id, exp.id));
    await db.delete(generationNaming).where(eq(generationNaming.generationId, gId));
    await db.delete(generations).where(inArray(generations.id, [gId]));
    await db.delete(folders).where(inArray(folders.id, [fId]));
  }
});

test("Compact names omit project names while preserving explicit folder names", async () => {
  const db = await getDb();
  const p1Id = randomUUID();
  const p2Id = randomUUID();
  const f1Id = randomUUID();
  const f2Id = randomUUID();

  const gAId = randomUUID();
  const gBId = randomUUID();
  const gCId = randomUUID();
  const gDId = randomUUID();

  await db.delete(generationNaming).where(inArray(generationNaming.generationId, [gAId, gBId, gCId, gDId])).catch(() => {});
  await db.delete(generations).where(inArray(generations.id, [gAId, gBId, gCId, gDId])).catch(() => {});
  await db.delete(folders).where(inArray(folders.id, [f1Id, f2Id])).catch(() => {});
  const { projects } = await import("./schema.js");
  await db.delete(projects).where(inArray(projects.id, [p1Id, p2Id])).catch(() => {});

  const now = Date.now();
  await db.insert(projects).values([
    { id: p1Id, name: "Alpha Beta", createdAt: now, updatedAt: now },
    { id: p2Id, name: "Alpha-Beta", createdAt: now, updatedAt: now },
  ]);

  await db.insert(folders).values([
    { id: f1Id, name: "alpha_beta_unsorted_aaaa", nameNormalized: "alpha_beta_unsorted_aaaa", version: 1, createdAt: now, updatedAt: now },
    { id: f2Id, name: "Alpha Beta Unsorted", nameNormalized: "alpha_beta_unsorted", version: 1, createdAt: now, updatedAt: now },
  ]);

  await db.insert(generations).values([
    { id: gAId, kind: "image", status: "completed", prompt: "pA", model: "m", aspectRatio: "1:1", projectId: p1Id, folderId: null, url: "https://storage.googleapis.com/b/gA.png", createdAt: now, updatedAt: now },
    { id: gBId, kind: "image", status: "completed", prompt: "pB", model: "m", aspectRatio: "1:1", projectId: p2Id, folderId: null, url: "https://storage.googleapis.com/b/gB.png", createdAt: now, updatedAt: now },
    { id: gCId, kind: "image", status: "completed", prompt: "pC", model: "m", aspectRatio: "1:1", projectId: null, folderId: f1Id, url: "https://storage.googleapis.com/b/gC.png", createdAt: now, updatedAt: now },
    { id: gDId, kind: "image", status: "completed", prompt: "pD", model: "m", aspectRatio: "1:1", projectId: null, folderId: f2Id, url: "https://storage.googleapis.com/b/gD.png", createdAt: now, updatedAt: now },
  ]);

  try {
    const map = await batchResolveGenerationFilenames(db, [gAId, gBId, gCId, gDId]);
    const fnA = map.get(gAId)?.filename;
    const fnB = map.get(gBId)?.filename;
    const fnC = map.get(gCId)?.filename;
    const fnD = map.get(gDId)?.filename;

    const allNames = [fnA, fnB, fnC, fnD];
    const uniqueNames = new Set(allNames);

    assert.equal(
      uniqueNames.size,
      3,
      `Both project-unsorted assets share a readable filename without project decoration`
    );
    assert.equal(fnA, "unsorted_0001.png");
    assert.equal(fnB, fnA);
    assert.equal(fnC, "alpha_beta_unsorted_aaaa_0001.png");
    assert.equal(fnD, "alpha_beta_unsorted_0001.png");
  } finally {
    await db.delete(generationNaming).where(inArray(generationNaming.generationId, [gAId, gBId, gCId, gDId])).catch(() => {});
    await db.delete(generations).where(inArray(generations.id, [gAId, gBId, gCId, gDId])).catch(() => {});
    await db.delete(folders).where(inArray(folders.id, [f1Id, f2Id])).catch(() => {});
    await db.delete(projects).where(inArray(projects.id, [p1Id, p2Id])).catch(() => {});
  }
});
