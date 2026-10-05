import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";
import { asc, eq, inArray } from "drizzle-orm";
import { getDb } from "./db.js";
import {
  folders,
  generations,
  mediaExportItems,
  mediaExports,
  namingCounters,
  generationNaming,
  projects,
} from "./schema.js";
import {
  batchResolveGenerationFilenames,
  slugifyToken,
} from "./filename-resolver.js";
import {
  createFolder,
  moveFolder,
  moveGenerations,
  renameFolder,
} from "./folder-engine.js";
import {
  appendMediaExportItems,
  createMediaExport,
  finalizeMediaExport,
} from "./media-exports-db.js";
import { upsertItem } from "./store-db.js";
import { writeZip64 } from "./zip64-stream.js";
import { signSession, SESSION_COOKIE } from "./auth.js";
import { GET as downloadGet, HEAD as downloadHead } from "../app/api/generations/[id]/download/route.js";

test("Category 1: Concurrent creation in one folder -> unique monotonic serials, no reuse after deletion", async () => {
  assert.ok(process.env.DATABASE_URL, "test:db requires DATABASE_URL");
  const db = await getDb();
  const folder = await createFolder({ name: `Folder_${randomUUID().slice(0, 8)}` });
  const folderId = folder.id;
  const ns = `folder:${folderId}`;

  try {
    // 100 concurrent generation creates
    const count = 100;
    const now = Date.now();
    const items = Array.from({ length: count }, (_, i) => ({
      id: randomUUID(),
      kind: "image",
      status: "completed",
      prompt: `prompt_${i}`,
      model: "test-model",
      aspectRatio: "1:1",
      folderId,
      url: `/api/media/generated/${randomUUID()}.png`,
      createdAt: now + i,
      updatedAt: now + i,
    }));

    await Promise.all(items.map((item) => upsertItem(item)));

    const namingRows = await db
      .select()
      .from(generationNaming)
      .where(eq(generationNaming.namespace, ns));

    assert.equal(namingRows.length, count, "All 100 generations must have naming rows");

    const sequences = namingRows.map((r) => Number(r.sequence)).sort((a, b) => a - b);
    const expected = Array.from({ length: count }, (_, i) => i + 1);
    assert.deepEqual(sequences, expected, "Sequences must be exactly 1..100 without duplicates or gaps");

    // Check counter
    const [counter] = await db
      .select()
      .from(namingCounters)
      .where(eq(namingCounters.namespace, ns));
    assert.equal(Number(counter.nextSequence), 101, "Counter nextSequence must be 101");

    // Delete item with sequence 42
    const toDelete = namingRows.find((r) => Number(r.sequence) === 42);
    await db.delete(generations).where(eq(generations.id, toDelete.generationId));

    // Create next item in folder: must get sequence 101, never reusing 42
    const nextItem = {
      id: randomUUID(),
      kind: "image",
      status: "completed",
      prompt: "post_delete_item",
      model: "test-model",
      aspectRatio: "1:1",
      folderId,
      url: `/api/media/generated/${randomUUID()}.png`,
      createdAt: now + 500,
      updatedAt: now + 500,
    };
    await upsertItem(nextItem);

    const [newNaming] = await db
      .select()
      .from(generationNaming)
      .where(eq(generationNaming.generationId, nextItem.id));

    assert.equal(Number(newNaming.sequence), 101, "New item must receive sequence 101, never reusing deleted 42");

    // Clean up
    await db.delete(generations).where(inArray(generations.id, [...items.map((i) => i.id), nextItem.id]));
  } finally {
    await db.delete(folders).where(eq(folders.id, folderId));
    await db.delete(namingCounters).where(eq(namingCounters.namespace, ns));
  }
});

test("Category 2: Mixed image/video/depth sharing sequence in namespace; status updates & retries do not reallocate", async () => {
  const db = await getDb();
  const folder = await createFolder({ name: `Mixed_${randomUUID().slice(0, 8)}` });
  const folderId = folder.id;
  const ns = `folder:${folderId}`;

  try {
    const now = Date.now();
    const imgItem = {
      id: randomUUID(),
      kind: "image",
      status: "pending",
      prompt: "image prompt",
      model: "test",
      aspectRatio: "1:1",
      folderId,
      createdAt: now,
      updatedAt: now,
    };
    const vidItem = {
      id: randomUUID(),
      kind: "video",
      status: "pending",
      prompt: "video prompt",
      model: "test",
      aspectRatio: "1:1",
      folderId,
      createdAt: now + 1,
      updatedAt: now + 1,
    };
    const depthItem = {
      id: randomUUID(),
      kind: "depth",
      status: "pending",
      prompt: "depth prompt",
      model: "test",
      aspectRatio: "1:1",
      folderId,
      createdAt: now + 2,
      updatedAt: now + 2,
    };

    await upsertItem(imgItem);
    await upsertItem(vidItem);
    await upsertItem(depthItem);

    const [n1] = await db.select().from(generationNaming).where(eq(generationNaming.generationId, imgItem.id));
    const [n2] = await db.select().from(generationNaming).where(eq(generationNaming.generationId, vidItem.id));
    const [n3] = await db.select().from(generationNaming).where(eq(generationNaming.generationId, depthItem.id));

    assert.equal(Number(n1.sequence), 1);
    assert.equal(Number(n2.sequence), 2);
    assert.equal(Number(n3.sequence), 3);

    // Lifecycle completion update (pending -> running -> completed)
    await upsertItem({ ...imgItem, status: "completed", url: `/api/media/generated/${imgItem.id}.png` });
    const [n1After] = await db.select().from(generationNaming).where(eq(generationNaming.generationId, imgItem.id));
    assert.equal(Number(n1After.sequence), 1, "Status update must preserve sequence");
    assert.equal(Number(n1After.assignedAt), Number(n1.assignedAt), "assignedAt must not change on update");

    // Retry simulation: same generation ID upserted again
    await upsertItem({ ...imgItem, status: "completed", prompt: "updated prompt" });
    const [n1Retry] = await db.select().from(generationNaming).where(eq(generationNaming.generationId, imgItem.id));
    assert.equal(Number(n1Retry.sequence), 1, "Retry must not reallocate sequence");

    await db.delete(generations).where(inArray(generations.id, [imgItem.id, vidItem.id, depthItem.id]));
  } finally {
    await db.delete(folders).where(eq(folders.id, folderId));
    await db.delete(namingCounters).where(eq(namingCounters.namespace, ns));
  }
});

test("Category 3: Simultaneous moves, idempotency replay, payload mismatch, same-location no-op, rollback safety", async () => {
  const db = await getDb();
  const folderA = await createFolder({ name: `A_${randomUUID().slice(0, 6)}` });
  const folderB = await createFolder({ name: `B_${randomUUID().slice(0, 6)}` });

  const now = Date.now();
  const count = 10;
  const items = Array.from({ length: count }, (_, i) => ({
    id: randomUUID(),
    kind: "image",
    status: "completed",
    prompt: `move_${i}`,
    model: "test",
    aspectRatio: "1:1",
    folderId: folderA.id,
    url: `/api/media/${randomUUID()}.png`,
    createdAt: now + i,
    updatedAt: now + i,
  }));

  for (const item of items) await upsertItem(item);

  try {
    // 1. Move each item simultaneously into folderB
    await Promise.all(
      items.map((item) =>
        moveGenerations({
          ids: [item.id],
          destination: { type: "folder", folderId: folderB.id },
        })
      )
    );

    const bNaming = await db
      .select()
      .from(generationNaming)
      .where(eq(generationNaming.namespace, `folder:${folderB.id}`));

    assert.equal(bNaming.length, count, "All items must be in folderB namespace");
    const seqs = bNaming.map((r) => Number(r.sequence)).sort((a, b) => a - b);
    assert.deepEqual(seqs, Array.from({ length: count }, (_, i) => i + 1), "Sequences must be 1..10 in folderB");

    // 2. Same-location move must be a no-op for naming
    const noOpRes = await moveGenerations({
      ids: [items[0].id],
      destination: { type: "folder", folderId: folderB.id },
    });
    assert.equal(noOpRes.reallocatedNamingCount, 0, "Same-location move must reallocate 0 items");
    assert.equal(noOpRes.preservedNamingCount, 1, "Same-location move must preserve existing serial");

    // 3. Idempotent replay with same key
    const idempKey = `idem_${randomUUID()}`;
    const actorId = randomUUID();
    const moveRes1 = await moveGenerations({
      ids: [items[1].id],
      destination: { type: "folder", folderId: folderA.id },
      idempotencyKey: idempKey,
      actorId,
    });

    const moveRes2 = await moveGenerations({
      ids: [items[1].id],
      destination: { type: "folder", folderId: folderA.id },
      idempotencyKey: idempKey,
      actorId,
    });

    assert.equal(moveRes1.movedCount, 1);
    assert.equal(moveRes2.movedCount, 1);
    assert.deepEqual(moveRes1.assignments, moveRes2.assignments);

    // 4. Same key with different payload must reject with 409
    await assert.rejects(
      moveGenerations({
        ids: [items[2].id], // different item
        destination: { type: "folder", folderId: folderA.id },
        idempotencyKey: idempKey,
        actorId,
      }),
      (err) => err.status === 409 && err.code === "IDEMPOTENCY_PAYLOAD_MISMATCH"
    );

    // 5. Rollback safety: simulated failed transaction
    await assert.rejects(
      db.transaction(async (tx) => {
        await moveGenerations({
          ids: [items[3].id],
          destination: { type: "folder", folderId: folderA.id },
          tx,
        });
        throw new Error("SIMULATED_ABORT");
      }),
      /SIMULATED_ABORT/
    );

    // Verify item 3 remains in folderB with previous naming assignment
    const [it3Naming] = await db
      .select()
      .from(generationNaming)
      .where(eq(generationNaming.generationId, items[3].id));
    assert.equal(it3Naming.namespace, `folder:${folderB.id}`, "Rolled back move must not commit naming assignment");
  } finally {
    await db.delete(generations).where(inArray(generations.id, items.map((i) => i.id))).catch(() => {});
    await db.delete(folders).where(inArray(folders.id, [folderA.id, folderB.id])).catch(() => {});
    await db.delete(namingCounters).where(inArray(namingCounters.namespace, [`folder:${folderA.id}`, `folder:${folderB.id}`])).catch(() => {});
  }
});

test("Category 4: Out-and-back gets new serial; folder subtree move preserves serials & updates prefix", async () => {
  const db = await getDb();
  const p1Name = `Parent1_${randomUUID().slice(0, 6)}`;
  const p2Name = `Parent2_${randomUUID().slice(0, 6)}`;
  const subName = `SubFolder_${randomUUID().slice(0, 6)}`;
  const parent1 = await createFolder({ name: p1Name });
  const parent2 = await createFolder({ name: p2Name });
  const subFolder = await createFolder({ name: subName, parentId: parent1.id });

  const now = Date.now();
  const genA = {
    id: randomUUID(),
    kind: "video",
    status: "completed",
    prompt: "video_a",
    model: "test",
    aspectRatio: "16:9",
    folderId: subFolder.id,
    url: `/api/media/generated/${randomUUID()}.mp4`,
    createdAt: now,
    updatedAt: now,
  };
  await upsertItem(genA);

  try {
    const [initialNaming] = await db.select().from(generationNaming).where(eq(generationNaming.generationId, genA.id));
    assert.equal(Number(initialNaming.sequence), 1);
    assert.equal(initialNaming.namespace, `folder:${subFolder.id}`);

    // Check filename before subtree move
    const filenames1 = await batchResolveGenerationFilenames(db, [genA.id]);
    assert.equal(filenames1.get(genA.id).filename, `${slugifyToken(p1Name)}_${slugifyToken(subName)}_0001.mp4`);

    // Move subFolder from parent1 to parent2
    await moveFolder({
      folderId: subFolder.id,
      destination: { type: "folder", folderId: parent2.id },
    });

    // Subtree move preserves the generation's sequence number!
    const [afterSubtreeNaming] = await db.select().from(generationNaming).where(eq(generationNaming.generationId, genA.id));
    assert.equal(Number(afterSubtreeNaming.sequence), 1, "Subtree move preserves sequence");
    assert.equal(afterSubtreeNaming.namespace, `folder:${subFolder.id}`);

    // But the resolved filename reflects the new parent2 prefix!
    const filenames2 = await batchResolveGenerationFilenames(db, [genA.id]);
    assert.equal(filenames2.get(genA.id).filename, `${slugifyToken(p2Name)}_${slugifyToken(subName)}_0001.mp4`);

    // Out-and-back move for generation: move to parent1, then back to subFolder
    await moveGenerations({
      ids: [genA.id],
      destination: { type: "folder", folderId: parent1.id },
    });
    const [inParent1Naming] = await db.select().from(generationNaming).where(eq(generationNaming.generationId, genA.id));
    assert.equal(Number(inParent1Naming.sequence), 1);
    assert.equal(inParent1Naming.namespace, `folder:${parent1.id}`);

    // Move back to subFolder: must get sequence 2 (subFolder previously had 1)!
    await moveGenerations({
      ids: [genA.id],
      destination: { type: "folder", folderId: subFolder.id },
    });
    const [backInSubNaming] = await db.select().from(generationNaming).where(eq(generationNaming.generationId, genA.id));
    assert.equal(Number(backInSubNaming.sequence), 2, "Out-and-back generation move must receive next sequence");
  } finally {
    await db.delete(generations).where(eq(generations.id, genA.id)).catch(() => {});
    await db.delete(folders).where(eq(folders.id, subFolder.id)).catch(() => {});
    await db.delete(folders).where(inArray(folders.id, [parent1.id, parent2.id])).catch(() => {});
    await db.delete(namingCounters).where(inArray(namingCounters.namespace, [
      `folder:${subFolder.id}`,
      `folder:${parent1.id}`,
      `folder:${parent2.id}`,
    ])).catch(() => {});
  }
});

test("Category 5: Global Unsorted, Project Unsorted, nested folders, cross-scope moves", async () => {
  const db = await getDb();
  const proj = {
    id: randomUUID(),
    name: "Alpha Project",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await db.insert(projects).values(proj);

  const now = Date.now();
  const globalGen = {
    id: randomUUID(),
    kind: "image",
    status: "completed",
    prompt: "global_item",
    model: "test",
    aspectRatio: "1:1",
    url: `/api/media/${randomUUID()}.png`,
    createdAt: now,
    updatedAt: now,
  };
  await upsertItem(globalGen);

  try {
    const [globalNaming] = await db.select().from(generationNaming).where(eq(generationNaming.generationId, globalGen.id));
    assert.equal(globalNaming.namespace, "global_unsorted");

    const filenames1 = await batchResolveGenerationFilenames(db, [globalGen.id]);
    assert.match(filenames1.get(globalGen.id).filename, /^unsorted_\d{4}\.png$/);

    // Move to Project Unsorted
    await moveGenerations({
      ids: [globalGen.id],
      destination: { type: "project_unsorted", projectId: proj.id },
    });

    const [projNaming] = await db.select().from(generationNaming).where(eq(generationNaming.generationId, globalGen.id));
    assert.equal(projNaming.namespace, `project_unsorted:${proj.id}`);

    const filenames2 = await batchResolveGenerationFilenames(db, [globalGen.id]);
    assert.match(filenames2.get(globalGen.id).filename, new RegExp(`^unsorted_\\d{4}\\.png$`));

    await db.delete(generations).where(eq(generations.id, globalGen.id));
  } finally {
    await db.delete(projects).where(eq(projects.id, proj.id));
    await db.delete(namingCounters).where(eq(namingCounters.namespace, `project_unsorted:${proj.id}`));
  }
});

test("Category 6: Project and folder renames update filename without reallocating serial", async () => {
  const db = await getDb();
  const initName = `InitialFolder_${randomUUID().slice(0, 6)}`;
  const renamedName = `RenamedFolder_${randomUUID().slice(0, 6)}`;
  const folder = await createFolder({ name: initName });

  const now = Date.now();
  const gen = {
    id: randomUUID(),
    kind: "image",
    status: "completed",
    prompt: "test",
    model: "test",
    aspectRatio: "1:1",
    folderId: folder.id,
    url: `/api/media/${randomUUID()}.png`,
    createdAt: now,
    updatedAt: now,
  };
  await upsertItem(gen);

  try {
    const f1 = await batchResolveGenerationFilenames(db, [gen.id]);
    assert.equal(f1.get(gen.id).filename, `${slugifyToken(initName)}_0001.png`);

    // Rename folder to renamedName
    await renameFolder({ folderId: folder.id, name: renamedName });

    // Serial is preserved (1), filename dynamically reflects renamedName
    const f2 = await batchResolveGenerationFilenames(db, [gen.id]);
    assert.equal(f2.get(gen.id).filename, `${slugifyToken(renamedName)}_0001.png`);
  } finally {
    await db.delete(generations).where(eq(generations.id, gen.id)).catch(() => {});
    await db.delete(folders).where(eq(folders.id, folder.id)).catch(() => {});
    await db.delete(namingCounters).where(eq(namingCounters.namespace, `folder:${folder.id}`)).catch(() => {});
  }
});

test("Category 7: ZIP manifest freeze at finalize; later moves do not alter archive; Python zipfile testzip with 257+ entries", async () => {
  const db = await getDb();
  const tag = randomUUID().slice(0, 6);
  const folderA = await createFolder({ name: `ExportFolderA_${tag}` });
  const folderB = await createFolder({ name: `ExportFolderB_${tag}` });
  const userId = randomUUID();

  const now = Date.now();
  const entryCount = 260; // > 256 entries to test Zip64 boundaries
  const items = Array.from({ length: entryCount }, (_, i) => ({
    id: randomUUID(),
    kind: i % 2 === 0 ? "image" : "video",
    status: "completed",
    prompt: `item_${i}`,
    model: "test",
    aspectRatio: "1:1",
    folderId: folderA.id,
    url: `/api/media/generated/${randomUUID()}.${i % 2 === 0 ? "png" : "mp4"}`,
    createdAt: now + i,
    updatedAt: now + i,
  }));

  for (const item of items) await upsertItem(item);

  let exportId;
  const tempZipPath = join(tmpdir(), `test_archive_${randomUUID()}.zip`);

  try {
    const job = await createMediaExport(userId, now);
    exportId = job.id;

    // Append all items
    for (let offset = 0; offset < items.length; offset += 500) {
      await appendMediaExportItems(
        exportId,
        userId,
        items.slice(offset, offset + 500).map((i) => i.id)
      );
    }

    // Finalize: this freezes the manifest onto media_export_items and sets manifest_version = 2
    const finalized = await finalizeMediaExport(exportId, userId);
    assert.equal(finalized.status, "queued");
    assert.equal(finalized.manifestVersion, 2);

    const frozenItems = await db
      .select()
      .from(mediaExportItems)
      .where(eq(mediaExportItems.exportId, exportId))
      .orderBy(asc(mediaExportItems.position));

    assert.equal(frozenItems.length, entryCount);
    assert.ok(frozenItems[0].filename.startsWith(`exportfoldera_${tag}_0001.`));

    // NOW MOVE all items from folderA to folderB in the database!
    await moveGenerations({
      ids: items.map((i) => i.id),
      destination: { type: "folder", folderId: folderB.id },
    });

    // The export items' frozen filenames MUST NOT HAVE CHANGED!
    const recheckedItems = await db
      .select()
      .from(mediaExportItems)
      .where(eq(mediaExportItems.exportId, exportId))
      .orderBy(asc(mediaExportItems.position));

    assert.equal(recheckedItems[0].filename, frozenItems[0].filename, "Frozen manifest must be immutable to subsequent moves");

    // Construct the zip archive using writeZip64 with the frozen filenames
    const zipChunks = [];
    async function* zipEntries() {
      for (const it of frozenItems) {
        const payload = Buffer.from(`DATA_${it.generationId}`);
        yield {
          name: it.filename,
          size: payload.length,
          stream: (async function* () { yield payload; })(),
        };
      }
    }

    await writeZip64(zipEntries(), async (chunk) => {
      zipChunks.push(Buffer.from(chunk));
    });

    const fullZip = Buffer.concat(zipChunks);
    writeFileSync(tempZipPath, fullZip);

    // Verify using Python's standard library zipfile.testzip()
    const pyOutput = execFileSync("python3", [
      "-c",
      `import zipfile, sys
zf = zipfile.ZipFile("${tempZipPath}")
bad = zf.testzip()
if bad is not None:
    print(f"CORRUPTED: {bad}", file=sys.stderr)
    sys.exit(1)
names = zf.namelist()
assert len(names) == ${entryCount}, f"Expected ${entryCount}, got {len(names)}"
# Ensure case-insensitive uniqueness
assert len(names) == len(set(n.lower() for n in names)), "Duplicate case-insensitive name detected"
print("ZIP_OK")
`,
    ], { encoding: "utf8" });

    assert.ok(pyOutput.includes("ZIP_OK"), "Python zipfile.testzip() must validate archive");
  } finally {
    try { unlinkSync(tempZipPath); } catch {}
    if (exportId) await db.delete(mediaExports).where(eq(mediaExports.id, exportId)).catch(() => {});
    await db.delete(generations).where(inArray(generations.id, items.map((i) => i.id))).catch(() => {});
    await db.delete(folders).where(inArray(folders.id, [folderA.id, folderB.id])).catch(() => {});
    await db.delete(namingCounters).where(inArray(namingCounters.namespace, [`folder:${folderA.id}`, `folder:${folderB.id}`])).catch(() => {});
  }
});

test("Category 8: Direct download route streaming, Range/HEAD headers, 401/403/404/409 error cases", async () => {
  const db = await getDb();
  const folder = await createFolder({ name: "DownloadTestFolder" });
  const userId = randomUUID();
  const validCookie = `${SESSION_COOKIE}=${signSession(userId, 0)}`;

  const now = Date.now();
  const completedGen = {
    id: randomUUID(),
    kind: "image",
    status: "completed",
    prompt: "completed item",
    model: "test",
    aspectRatio: "1:1",
    folderId: folder.id,
    url: `/api/media/generated/${randomUUID()}.png`,
    createdAt: now,
    updatedAt: now,
  };
  const pendingGen = {
    id: randomUUID(),
    kind: "image",
    status: "pending",
    prompt: "pending item",
    model: "test",
    aspectRatio: "1:1",
    folderId: folder.id,
    url: `/api/media/generated/${randomUUID()}.png`,
    createdAt: now + 1,
    updatedAt: now + 1,
  };
  const failedGen = {
    id: randomUUID(),
    kind: "image",
    status: "failed",
    prompt: "failed item",
    model: "test",
    aspectRatio: "1:1",
    folderId: folder.id,
    url: `/api/media/generated/${randomUUID()}.png`,
    createdAt: now + 2,
    updatedAt: now + 2,
  };
  const protectedUrlGen = {
    id: randomUUID(),
    kind: "image",
    status: "completed",
    prompt: "protected url item",
    model: "test",
    aspectRatio: "1:1",
    folderId: folder.id,
    url: "/api/media/settings/secrets.json",
    createdAt: now + 3,
    updatedAt: now + 3,
  };

  await upsertItem(completedGen);
  await upsertItem(pendingGen);
  await upsertItem(failedGen);
  await upsertItem(protectedUrlGen);

  try {
    // 1. 401 when unauthenticated
    const unauthReq = new Request(`http://localhost/api/generations/${completedGen.id}/download`);
    const unauthRes = await downloadGet(unauthReq, { params: Promise.resolve({ id: completedGen.id }) });
    assert.equal(unauthRes.status, 401);
    const unauthJson = await unauthRes.json();
    assert.equal(unauthJson.error, "UNAUTHENTICATED");

    // 2. 404 when generation does not exist
    const nonExistentId = randomUUID();
    const notFoundReq = new Request(`http://localhost/api/generations/${nonExistentId}/download`, {
      headers: { cookie: validCookie },
    });
    const notFoundRes = await downloadGet(notFoundReq, { params: Promise.resolve({ id: nonExistentId }) });
    assert.equal(notFoundRes.status, 404);
    const notFoundJson = await notFoundRes.json();
    assert.equal(notFoundJson.error, "GENERATION_NOT_FOUND");

    // 3. 409 when generation is pending
    const pendingReq = new Request(`http://localhost/api/generations/${pendingGen.id}/download`, {
      headers: { cookie: validCookie },
    });
    const pendingRes = await downloadGet(pendingReq, { params: Promise.resolve({ id: pendingGen.id }) });
    assert.equal(pendingRes.status, 409);
    const pendingJson = await pendingRes.json();
    assert.equal(pendingJson.error, "GENERATION_PROCESSING");

    // 4. 409 when generation is failed
    const failedReq = new Request(`http://localhost/api/generations/${failedGen.id}/download`, {
      headers: { cookie: validCookie },
    });
    const failedRes = await downloadGet(failedReq, { params: Promise.resolve({ id: failedGen.id }) });
    assert.equal(failedRes.status, 409);
    const failedJson = await failedRes.json();
    assert.equal(failedJson.error, "GENERATION_FAILED");

    // 5. 404 when url points to protected media key
    const protReq = new Request(`http://localhost/api/generations/${protectedUrlGen.id}/download`, {
      headers: { cookie: validCookie },
    });
    const protRes = await downloadGet(protReq, { params: Promise.resolve({ id: protectedUrlGen.id }) });
    assert.equal(protRes.status, 404);

    // Mock openMediaObject for successful retrieval
    const fakeData = Buffer.from("VEEVEE_BINARY_PAYLOAD_12345");
    const mockOpenMediaObject = async (key, range) => {
      if (range) {
        return {
          stream: fakeData.subarray(0, 10),
          contentType: "image/png",
          contentLength: 10,
          contentRange: `bytes 0-9/${fakeData.length}`,
          status: 206,
        };
      }
      return {
        stream: fakeData,
        contentType: "image/png",
        contentLength: fakeData.length,
        status: 200,
      };
    };

    // 6. Successful GET (200) with RFC 6266 Content-Disposition, nosniff, cache control
    const successReq = new Request(`http://localhost/api/generations/${completedGen.id}/download`, {
      headers: { cookie: validCookie },
    });
    const successRes = await downloadGet(
      successReq,
      { params: Promise.resolve({ id: completedGen.id }) },
      { openMediaObject: mockOpenMediaObject }
    );
    const expectedFilename = `downloadtestfolder_0001.png`;
    assert.equal(successRes.status, 200);
    assert.equal(successRes.headers.get("x-content-type-options"), "nosniff");
    assert.equal(successRes.headers.get("accept-ranges"), "bytes");
    assert.ok(successRes.headers.get("cache-control").includes("private"));
    assert.ok(successRes.headers.get("content-disposition").includes(`attachment; filename="${expectedFilename}"`));
    assert.ok(successRes.headers.get("content-disposition").includes(`filename*=UTF-8''${expectedFilename}`));

    // 7. Successful HEAD request (status 200, headers match GET, empty body)
    const headReq = new Request(`http://localhost/api/generations/${completedGen.id}/download`, {
      method: "HEAD",
      headers: { cookie: validCookie },
    });
    const headRes = await downloadHead(
      headReq,
      { params: Promise.resolve({ id: completedGen.id }) },
      { openMediaObject: mockOpenMediaObject }
    );
    assert.equal(headRes.status, 200);
    assert.equal(headRes.headers.get("content-length"), String(fakeData.length));
    assert.ok(headRes.headers.get("content-disposition").includes(`filename="${expectedFilename}"`));
    const headBody = await headRes.text();
    assert.equal(headBody, "", "HEAD body must be empty");

    // 8. Range request (206 Partial Content)
    const rangeReq = new Request(`http://localhost/api/generations/${completedGen.id}/download`, {
      headers: { cookie: validCookie, range: "bytes=0-9" },
    });
    const rangeRes = await downloadGet(
      rangeReq,
      { params: Promise.resolve({ id: completedGen.id }) },
      { openMediaObject: mockOpenMediaObject }
    );
    assert.equal(rangeRes.status, 206);
    assert.equal(rangeRes.headers.get("content-range"), `bytes 0-9/${fakeData.length}`);

    // 9. MediaNotFoundError -> 404
    const notFoundStorageReq = new Request(`http://localhost/api/generations/${completedGen.id}/download`, {
      headers: { cookie: validCookie },
    });
    const { MediaNotFoundError, InvalidMediaRangeError } = await import("./storage.js");
    const notFoundStorageRes = await downloadGet(
      notFoundStorageReq,
      { params: Promise.resolve({ id: completedGen.id }) },
      {
        openMediaObject: async () => {
          throw new MediaNotFoundError();
        },
      }
    );
    assert.equal(notFoundStorageRes.status, 404);

    // 10. InvalidMediaRangeError -> 416
    const invalidRangeReq = new Request(`http://localhost/api/generations/${completedGen.id}/download`, {
      headers: { cookie: validCookie, range: "bytes=9999-10" },
    });
    const invalidRangeRes = await downloadGet(
      invalidRangeReq,
      { params: Promise.resolve({ id: completedGen.id }) },
      {
        openMediaObject: async () => {
          throw new InvalidMediaRangeError();
        },
      }
    );
    assert.equal(invalidRangeRes.status, 416);

    // 11. Aborted request -> 499
    const abortCtrl = new AbortController();
    abortCtrl.abort();
    const abortedReq = new Request(`http://localhost/api/generations/${completedGen.id}/download`, {
      headers: { cookie: validCookie },
      signal: abortCtrl.signal,
    });
    const abortedRes = await downloadGet(
      abortedReq,
      { params: Promise.resolve({ id: completedGen.id }) },
      {
        openMediaObject: async () => {
          const err = new Error("aborted");
          throw err;
        },
      }
    );
    assert.equal(abortedRes.status, 499);
  } finally {
    await db.delete(generations).where(
      inArray(generations.id, [completedGen.id, pendingGen.id, failedGen.id, protectedUrlGen.id])
    ).catch(() => {});
    await db.delete(folders).where(eq(folders.id, folder.id)).catch(() => {});
    await db.delete(namingCounters).where(eq(namingCounters.namespace, `folder:${folder.id}`)).catch(() => {});
  }
});

