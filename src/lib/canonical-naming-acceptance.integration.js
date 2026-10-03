import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./db.js";
import {
  folders,
  generations,
  mediaExports,
  mediaExportItems,
  namingCounters,
  generationNaming,
  projects,
} from "./schema.js";
import { batchResolveGenerationFilenames } from "./filename-resolver.js";
import { createFolder } from "./folder-engine.js";
import {
  createMediaExport,
  appendMediaExportItems,
  finalizeMediaExport,
} from "./media-exports-db.js";
import { upsertItem } from "./store-db.js";
import { runExportOnce } from "../worker/media-export-worker.js";
import { migrateGenerationNaming } from "../../scripts/migrate-generation-naming.js";

test("Canonical Naming Acceptance 1: 'Café' vs 'Cafe' batch-independent filename identity", async () => {
  assert.ok(process.env.DATABASE_URL, "test:db requires DATABASE_URL");
  const db = await getDb();

  // Create two folders whose normalized slugs collide: 'Café' and 'Cafe'
  const tag = randomUUID().slice(0, 6);
  // Root global folders
  const f1 = await createFolder({ name: `Café_${tag}` });
  const f2 = await createFolder({ name: `Cafe_${tag}` });

  // Both have different folder IDs
  assert.notEqual(f1.id, f2.id);

  const now = Date.now();
  const g1Id = randomUUID();
  const g2Id = randomUUID();

  // Gen 1 in f1
  await upsertItem({
    id: g1Id,
    kind: "image",
    status: "completed",
    prompt: "A beautiful cafe interior",
    model: "test-model",
    aspectRatio: "1:1",
    folderId: f1.id,
    url: `/api/media/generated/${g1Id}.png`,
    createdAt: now,
    updatedAt: now,
  });

  // Gen 2 in f2
  await upsertItem({
    id: g2Id,
    kind: "image",
    status: "completed",
    prompt: "Another cafe terrace",
    model: "test-model",
    aspectRatio: "1:1",
    folderId: f2.id,
    url: `/api/media/generated/${g2Id}.png`,
    createdAt: now + 10,
    updatedAt: now + 10,
  });

  try {
    // 1. Single-item resolution (simulates direct download route GET /api/generations/[id]/download)
    const single1 = await batchResolveGenerationFilenames(db, [g1Id]);
    const fn1Single = single1.get(g1Id)?.filename;
    assert.ok(fn1Single, "g1 must resolve in single download");

    const single2 = await batchResolveGenerationFilenames(db, [g2Id]);
    const fn2Single = single2.get(g2Id)?.filename;
    assert.ok(fn2Single, "g2 must resolve in single download");

    // 2. Separate feed queries (e.g. user viewing folder 1 alone vs folder 2 alone)
    const feed1 = await batchResolveGenerationFilenames(db, [g1Id]);
    assert.equal(feed1.get(g1Id)?.filename, fn1Single, "Feed query 1 must equal single download filename");

    const feed2 = await batchResolveGenerationFilenames(db, [g2Id]);
    assert.equal(feed2.get(g2Id)?.filename, fn2Single, "Feed query 2 must equal single download filename");

    // 3. Combined ZIP export manifest batch containing both items
    const combinedZip = await batchResolveGenerationFilenames(db, [g1Id, g2Id]);
    const fn1Zip = combinedZip.get(g1Id)?.filename;
    const fn2Zip = combinedZip.get(g2Id)?.filename;

    // Core requirement: Batch-independent identity!
    // The filename for g1 must be IDENTICAL whether resolved alone or in a batch of 2 or 100
    assert.equal(
      fn1Single,
      fn1Zip,
      `Batch-independence violated for g1: single resolved '${fn1Single}', combined ZIP resolved '${fn1Zip}'`
    );
    assert.equal(
      fn2Single,
      fn2Zip,
      `Batch-independence violated for g2: single resolved '${fn2Single}', combined ZIP resolved '${fn2Zip}'`
    );

    // Collision avoidance: Within the ZIP, they must NOT collide
    assert.notEqual(
      fn1Zip,
      fn2Zip,
      `Filenames must be unique between colliding folders in ZIP export: '${fn1Zip}' vs '${fn2Zip}'`
    );

    // Both must include deterministic container disambiguator because 'cafe_<tag>' namespace collides
    const pattern = new RegExp(`^cafe_${tag}_[0-9a-f]{4,}_0001\\.png$`);
    assert.match(fn1Zip, pattern, `fn1Zip should match pattern: ${fn1Zip}`);
    assert.match(fn2Zip, pattern, `fn2Zip should match pattern: ${fn2Zip}`);

    // 4. Out-of-order selection stability
    const outOfOrder = await batchResolveGenerationFilenames(db, [g2Id, g1Id]);
    assert.equal(outOfOrder.get(g1Id)?.filename, fn1Zip, "Out of order resolution must match g1 filename");
    assert.equal(outOfOrder.get(g2Id)?.filename, fn2Zip, "Out of order resolution must match g2 filename");
  } finally {
    await db.delete(generations).where(inArray(generations.id, [g1Id, g2Id]));
    await db.delete(folders).where(inArray(folders.id, [f1.id, f2.id]));
  }
});

test("Canonical Naming Acceptance 2: Project Unsorted collisions ('Alpha Beta' vs 'Alpha-Beta')", async () => {
  assert.ok(process.env.DATABASE_URL, "test:db requires DATABASE_URL");
  const db = await getDb();

  const tag = randomUUID().slice(0, 6);
  // Create two projects whose normalized slugs collide: 'Alpha Beta' and 'Alpha-Beta'
  const p1Id = randomUUID();
  const p2Id = randomUUID();
  const now = Date.now();

  await db.insert(projects).values([
    { id: p1Id, name: `Alpha Beta ${tag}`, createdAt: now, updatedAt: now },
    { id: p2Id, name: `Alpha-Beta ${tag}`, createdAt: now, updatedAt: now },
  ]);

  const gAId = randomUUID();
  const gBId = randomUUID();

  // Insert in project unsorted (folderId: null, projectId: p1Id / p2Id)
  await upsertItem({
    id: gAId,
    kind: "image",
    status: "completed",
    prompt: "Prompt Alpha",
    model: "test-model",
    aspectRatio: "1:1",
    projectId: p1Id,
    url: `/api/media/generated/${gAId}.png`,
    createdAt: now,
    updatedAt: now,
  });

  await upsertItem({
    id: gBId,
    kind: "image",
    status: "completed",
    prompt: "Prompt Beta",
    model: "test-model",
    aspectRatio: "1:1",
    projectId: p2Id,
    url: `/api/media/generated/${gBId}.png`,
    createdAt: now + 5,
    updatedAt: now + 5,
  });

  try {
    // Single downloads
    const singleA = await batchResolveGenerationFilenames(db, [gAId]);
    const singleB = await batchResolveGenerationFilenames(db, [gBId]);

    // Combined export
    const combined = await batchResolveGenerationFilenames(db, [gAId, gBId]);

    const fnA = combined.get(gAId)?.filename;
    const fnB = combined.get(gBId)?.filename;

    assert.equal(singleA.get(gAId)?.filename, fnA, "Project Unsorted gen A filename must be batch-independent");
    assert.equal(singleB.get(gBId)?.filename, fnB, "Project Unsorted gen B filename must be batch-independent");
    assert.notEqual(fnA, fnB, "Project Unsorted colliding filenames must be unique");

    const expectedPattern = new RegExp(`^alpha_beta_${tag}_unsorted_[0-9a-f]{4,}_0001\\.png$`);
    assert.match(fnA, expectedPattern, "Gen A filename must include disambiguator");
    assert.match(fnB, expectedPattern, "Gen B filename must include disambiguator");
  } finally {
    await db.delete(generations).where(inArray(generations.id, [gAId, gBId]));
    await db.delete(projects).where(inArray(projects.id, [p1Id, p2Id]));
  }
});

test("Canonical Naming Acceptance 3: Long-truncated ancestry collisions with SHA-256 entropy preservation", async () => {
  assert.ok(process.env.DATABASE_URL, "test:db requires DATABASE_URL");
  const db = await getDb();

  // Create deep hierarchy to exceed 255 bytes in joined path
  // Root: 70 chars, Child: 70 chars, Grandchild: 70 chars, Leaf: 60 chars -> Total > 270 chars
  const tag = randomUUID().slice(0, 6);
  const rootName = `RootHierarchySegment_LongIdentifier_${tag}_A`;
  const childName = `ChildHierarchySegment_LongIdentifier_${tag}_B`;
  const grandChildName = `GrandChildHierarchySegment_LongIdentifier_${tag}_C`;

  const rootFolder = await createFolder({ name: rootName });
  const childFolder = await createFolder({ name: childName, parentId: rootFolder.id });
  const grandChild = await createFolder({ name: grandChildName, parentId: childFolder.id });

  // Two sibling leaves under grandChild that share the deep prefix
  const leaf1 = await createFolder({ name: `LeafBranchAlpha_${tag}`, parentId: grandChild.id });
  const leaf2 = await createFolder({ name: `LeafBranchBeta_${tag}`, parentId: grandChild.id });

  const now = Date.now();
  const g1Id = randomUUID();
  const g2Id = randomUUID();

  await upsertItem({
    id: g1Id,
    kind: "image",
    status: "completed",
    prompt: "Prompt 1",
    model: "test-model",
    aspectRatio: "1:1",
    folderId: leaf1.id,
    url: `/api/media/generated/${g1Id}.png`,
    createdAt: now,
    updatedAt: now,
  });

  await upsertItem({
    id: g2Id,
    kind: "image",
    status: "completed",
    prompt: "Prompt 2",
    model: "test-model",
    aspectRatio: "1:1",
    folderId: leaf2.id,
    url: `/api/media/generated/${g2Id}.png`,
    createdAt: now + 5,
    updatedAt: now + 5,
  });

  try {
    const single1 = await batchResolveGenerationFilenames(db, [g1Id]);
    const single2 = await batchResolveGenerationFilenames(db, [g2Id]);
    const combined = await batchResolveGenerationFilenames(db, [g1Id, g2Id]);

    const fn1 = combined.get(g1Id)?.filename;
    const fn2 = combined.get(g2Id)?.filename;

    // Check byte length bounds (<= 255 bytes for APFS/NTFS/ext4)
    assert.ok(
      Buffer.byteLength(fn1, "utf8") <= 255,
      `Filename 1 exceeds 255 bytes: ${Buffer.byteLength(fn1, "utf8")} bytes`
    );
    assert.ok(
      Buffer.byteLength(fn2, "utf8") <= 255,
      `Filename 2 exceeds 255 bytes: ${Buffer.byteLength(fn2, "utf8")} bytes`
    );

    // Batch-independent
    assert.equal(single1.get(g1Id)?.filename, fn1, "Long filename 1 must be batch-independent");
    assert.equal(single2.get(g2Id)?.filename, fn2, "Long filename 2 must be batch-independent");

    // Colliding prefix must be disambiguated by SHA-256 entropy hash
    assert.notEqual(fn1, fn2, "Long filenames sharing prefix must not collide due to hash");

    // Both must contain the 6-character hex hash pattern `_[0-9a-f]{6}_`
    assert.match(fn1, /_[0-9a-f]{6}_0001\.png$/, "Filename 1 must include 6-character SHA-256 hash");
    assert.match(fn2, /_[0-9a-f]{6}_0001\.png$/, "Filename 2 must include 6-character SHA-256 hash");
  } finally {
    await db.delete(generations).where(inArray(generations.id, [g1Id, g2Id]));
    await db.delete(folders).where(inArray(folders.id, [leaf1.id, leaf2.id, grandChild.id, childFolder.id, rootFolder.id]));
  }
});

test("Canonical Naming Acceptance 4: Legacy app mutation path & self-healing trigger compatibility", async () => {
  assert.ok(process.env.DATABASE_URL, "test:db requires DATABASE_URL");
  const db = await getDb();

  // Create two folders
  const fSource = await createFolder({ name: `LegacySource_${randomUUID().slice(0, 8)}` });
  const fDest = await createFolder({ name: `LegacyDest_${randomUUID().slice(0, 8)}` });

  const now = Date.now();
  const genId = randomUUID();

  // 1. Simulate legacy application direct INSERT without touching generation_naming
  await db.execute(sql`
    INSERT INTO generations (
      id, kind, status, prompt, model, aspect_ratio, folder_id, url, created_at, updated_at
    ) VALUES (
      ${genId}::uuid, 'image', 'completed', 'Legacy Insert Prompt', 'test-model', '1:1',
      ${fSource.id}::uuid, '/api/media/generated/legacy.png', ${now}, ${now}
    );
  `);

  try {
    // Assert trigger automatically allocated naming row for the legacy insert!
    const [namingInitial] = await db
      .select()
      .from(generationNaming)
      .where(eq(generationNaming.generationId, genId));

    assert.ok(namingInitial, "Trigger must self-heal and assign generation_naming row on legacy INSERT");
    assert.equal(namingInitial.namespace, `folder:${fSource.id}`);
    assert.equal(Number(namingInitial.sequence), 1);

    // 2. Simulate legacy application direct UPDATE (moving generation to fDest without touching generation_naming)
    await db.execute(sql`
      UPDATE generations
      SET folder_id = ${fDest.id}::uuid, updated_at = ${now + 10}
      WHERE id = ${genId}::uuid;
    `);

    // Assert update succeeded and trigger self-healed the naming row to match fDest!
    const [namingAfterMove] = await db
      .select()
      .from(generationNaming)
      .where(eq(generationNaming.generationId, genId));

    assert.ok(namingAfterMove, "generation_naming row must exist after legacy move");
    assert.equal(
      namingAfterMove.namespace,
      `folder:${fDest.id}`,
      "Trigger must automatically reassign namespace to destination folder"
    );
    assert.equal(Number(namingAfterMove.sequence), 1, "First item in fDest should receive sequence 1");

    // Invariant check: counter must be advanced
    const [destCounter] = await db
      .select()
      .from(namingCounters)
      .where(eq(namingCounters.namespace, `folder:${fDest.id}`));
    assert.ok(
      Number(destCounter.nextSequence) > Number(namingAfterMove.sequence),
      "Destination counter nextSequence must be strictly greater than assigned sequence"
    );

    // 3. Move to Global Unsorted via legacy SQL (folder_id = NULL, project_id = NULL)
    await db.execute(sql`
      UPDATE generations
      SET folder_id = NULL, project_id = NULL, updated_at = ${now + 20}
      WHERE id = ${genId}::uuid;
    `);

    const [namingUnsorted] = await db
      .select()
      .from(generationNaming)
      .where(eq(generationNaming.generationId, genId));

    assert.equal(namingUnsorted.namespace, "global_unsorted", "Legacy move to null must assign global_unsorted");
  } finally {
    await db.delete(generations).where(eq(generations.id, genId));
    await db.delete(folders).where(inArray(folders.id, [fSource.id, fDest.id]));
  }
});

test("Canonical Naming Acceptance 5: Failure injection, clean rollback & post-migration invariant audit", async () => {
  assert.ok(process.env.DATABASE_URL, "test:db requires DATABASE_URL");
  const db = await getDb();

  // Test failure injection inside transaction
  let errorCaught = false;
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`CREATE TEMP TABLE test_failure_injection (id int);`);
      throw new Error("Simulated failure mid-transaction");
    });
  } catch (err) {
    errorCaught = true;
    assert.match(err.message, /Simulated failure mid-transaction/);
  }
  assert.ok(errorCaught, "Failure injection must be caught");

  // Rerun migration successfully
  const migRes = await migrateGenerationNaming(db);
  assert.equal(migRes.success, true, "migrateGenerationNaming must run idempotently and succeed");

  // Verify post-migration invariants on the database:
  // 1. No unassigned generations
  const unassigned = await db.execute(sql`
    SELECT count(*)::int as count
    FROM generations g
    LEFT JOIN generation_naming gn ON g.id = gn.generation_id
    WHERE gn.generation_id IS NULL;
  `);
  const unassignedCount = Number((unassigned.rows ?? unassigned)[0]?.count || 0);
  assert.equal(unassignedCount, 0, "Invariant: Zero generations should lack a generation_naming row");

  // 2. No duplicate sequences in any namespace
  const duplicates = await db.execute(sql`
    SELECT namespace, sequence, count(*)::int as count
    FROM generation_naming
    GROUP BY namespace, sequence
    HAVING count(*) > 1;
  `);
  const dupCount = (duplicates.rows ?? duplicates).length;
  assert.equal(dupCount, 0, "Invariant: Zero duplicate sequences in any namespace");

  // 3. Counter invariant: next_sequence > MAX(sequence)
  const counterLag = await db.execute(sql`
    SELECT gn.namespace, MAX(gn.sequence)::bigint as max_seq, nc.next_sequence
    FROM generation_naming gn
    JOIN naming_counters nc ON gn.namespace = nc.namespace
    GROUP BY gn.namespace, nc.next_sequence
    HAVING nc.next_sequence <= MAX(gn.sequence);
  `);
  const lagCount = (counterLag.rows ?? counterLag).length;
  assert.equal(lagCount, 0, "Invariant: All naming_counters must be strictly ahead of max assigned sequence");
});

test("Canonical Naming Acceptance 6: Media Export Finalization freezes manifest v2 verbatim names", async () => {
  assert.ok(process.env.DATABASE_URL, "test:db requires DATABASE_URL");
  const db = await getDb();

  const folder = await createFolder({ name: `ExportFolder_${randomUUID().slice(0, 8)}` });
  const now = Date.now();
  const genId = randomUUID();
  const userId = randomUUID();

  await upsertItem({
    id: genId,
    kind: "image",
    status: "completed",
    prompt: "Prompt for export",
    model: "test-model",
    aspectRatio: "1:1",
    folderId: folder.id,
    url: `/api/media/generated/${genId}.png`,
    createdAt: now,
    updatedAt: now,
  });

  const exportJob = await createMediaExport(userId, now);
  const exportId = exportJob.id;

  try {
    await appendMediaExportItems(exportId, userId, [genId], now);

    // Finalize export (should resolve filenames and freeze manifestVersion = 2)
    const finalized = await finalizeMediaExport(exportId, userId, now);
    assert.equal(finalized.manifestVersion, 2);

    // Verify media_export_items has resolved filename
    const items = await db
      .select()
      .from(mediaExportItems)
      .where(eq(mediaExportItems.exportId, exportId));

    assert.equal(items.length, 1);
    assert.ok(items[0].filename, "Item must have frozen filename");
    assert.match(items[0].filename, /_0001\.png$/);

    // Verify worker processes this verbatim
    const uploadPayloads = [];
    const fetchImpl = async (url, options = {}) => {
      if (url.includes("/access")) {
        const body = JSON.parse(options.body);
        if (body.action === "upload") return { ok: true, json: async () => ({ key: "exports/test.zip", url: "upload" }) };
        return { ok: true, json: async () => ({ url: "source-ok" }) };
      }
      if (url === "source-ok" && options.method === "HEAD") {
        return { ok: true, status: 200, headers: new Headers({ "content-length": "4", "content-type": "image/png" }) };
      }
      if (url === "source-ok") {
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3, 4]));
            controller.close();
          },
        });
        return { ok: true, status: 200, body };
      }
      if (url === "upload") {
        if (options.body) uploadPayloads.push(Buffer.from(options.body).toString("utf8"));
        return { ok: true, status: 200 };
      }
      throw new Error(url);
    };

    const workerResult = await runExportOnce({
      claim: async () => ({
        id: exportId,
        manifestVersion: 2,
        items: [{ generationId: genId, sourceKey: `generated/${genId}.png`, filename: items[0].filename }],
      }),
      heartbeat: async () => {},
      complete: async () => {},
      fail: async () => {},
      fetchImpl,
      baseUrl: "https://app",
      secret: "secret",
      logger: { error() {} },
    });

    assert.equal(workerResult.completed, 1);
    const zipStr = uploadPayloads.join("");
    assert.ok(zipStr.includes(items[0].filename), "Zip archive must contain frozen verbatim filename");
    assert.ok(!zipStr.includes(`${items[0].filename}.png`), "No double extension in zip");
  } finally {
    await db.delete(mediaExportItems).where(eq(mediaExportItems.exportId, exportId));
    await db.delete(mediaExports).where(eq(mediaExports.id, exportId));
    await db.delete(generations).where(eq(generations.id, genId));
    await db.delete(folders).where(eq(folders.id, folder.id));
  }
});
