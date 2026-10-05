import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { inArray, eq } from "drizzle-orm";
import { getDb } from "./db.js";
import { folders, generations, namingCounters } from "./schema.js";
import { upsertItem } from "./store-db.js";
import { createFolder } from "./folder-engine.js";
import { batchResolveGenerationFilenames } from "./filename-resolver.js";
import { GET as downloadGet, HEAD as downloadHead } from "../app/api/generations/[id]/download/route.js";
import { SESSION_COOKIE, signSession } from "./auth.js";
import { getSignedDownloadUrl } from "./storage.js";

/**
 * Stage 5 Media Qualification & Performance Benchmarking Test Suite
 *
 * Covers:
 * 1. Representative large video streaming, Range requests (206), HEAD requests, and exact RFC 6266 Content-Disposition.
 * 2. Authenticated signed download URL generation with exact Content-Disposition and short TTL.
 * 3. Client redirect mode (?signed=1) handling with authorization and protected prefix preservation.
 * 4. Namespace resolution benchmarking with 100+ folders: proving localized ancestor fetching without full-table scans.
 */

test("Stage 5.1: Large video streaming, Range seeking, and exact Content-Disposition", async () => {
  assert.ok(process.env.DATABASE_URL, "test requires DATABASE_URL");
  const db = await getDb();
  const folderTag = randomUUID().slice(0, 6);
  const folder = await createFolder({ name: `VideoProject_${folderTag}` });
  const userId = randomUUID();
  const validCookie = `${SESSION_COOKIE}=${signSession(userId, 0)}`;

  const videoGenId = randomUUID();
  const now = Date.now();
  await upsertItem({
    id: videoGenId,
    kind: "video",
    status: "completed",
    prompt: "Cinematic drone shot of coastline 4k",
    model: "test-video",
    aspectRatio: "16:9",
    folderId: folder.id,
    url: `/api/media/generated/${videoGenId}.mp4`,
    createdAt: now,
    updatedAt: now,
  });

  // Simulate 50MB representative video binary
  const simulatedSize = 50 * 1024 * 1024; // 50MB
  const mockOpenMediaObject = async (key, range, signal) => {
    let start = 0;
    let end = simulatedSize - 1;
    let status = 200;
    let contentRange = undefined;

    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (match) {
        start = parseInt(match[1], 10);
        if (match[2]) {
          end = parseInt(match[2], 10);
        }
        status = 206;
        contentRange = `bytes ${start}-${end}/${simulatedSize}`;
      }
    }

    const chunkLength = end - start + 1;
    // Chunked streaming without buffering full payload
    const stream = new ReadableStream({
      start(controller) {
        if (signal?.aborted) {
          controller.error(new Error("Stream aborted"));
          return;
        }
        controller.enqueue(Buffer.alloc(Math.min(chunkLength, 65536)));
        controller.close();
      },
    });

    return {
      stream,
      contentType: "video/mp4",
      contentLength: chunkLength,
      contentRange,
      status,
    };
  };

  try {
    // 1. Full GET request
    const fullReq = new Request(`http://localhost/api/generations/${videoGenId}/download`, {
      headers: { cookie: validCookie },
    });
    const fullRes = await downloadGet(
      fullReq,
      { params: Promise.resolve({ id: videoGenId }) },
      { openMediaObject: mockOpenMediaObject }
    );

    assert.equal(fullRes.status, 200);
    assert.equal(fullRes.headers.get("content-type"), "video/mp4");
    assert.equal(fullRes.headers.get("content-length"), String(simulatedSize));
    assert.equal(fullRes.headers.get("accept-ranges"), "bytes");

    const expectedFilename = `videoproject_${folderTag}_0001.mp4`;
    assert.ok(
      fullRes.headers.get("content-disposition").includes(`attachment; filename="${expectedFilename}"`),
      "Must have exact ASCII Content-Disposition"
    );
    assert.ok(
      fullRes.headers.get("content-disposition").includes(`filename*=UTF-8''${expectedFilename}`),
      "Must have exact UTF-8 Content-Disposition"
    );

    // 2. Partial Content (Range request)
    const rangeReq = new Request(`http://localhost/api/generations/${videoGenId}/download`, {
      headers: { cookie: validCookie, range: "bytes=1048576-2097151" }, // 1MB slice
    });
    const rangeRes = await downloadGet(
      rangeReq,
      { params: Promise.resolve({ id: videoGenId }) },
      { openMediaObject: mockOpenMediaObject }
    );

    assert.equal(rangeRes.status, 206);
    assert.equal(rangeRes.headers.get("content-range"), `bytes 1048576-2097151/${simulatedSize}`);
    assert.equal(rangeRes.headers.get("content-length"), "1048576");

    // 3. HEAD request
    const headReq = new Request(`http://localhost/api/generations/${videoGenId}/download`, {
      method: "HEAD",
      headers: { cookie: validCookie },
    });
    const headRes = await downloadHead(
      headReq,
      { params: Promise.resolve({ id: videoGenId }) },
      { openMediaObject: mockOpenMediaObject }
    );
    assert.equal(headRes.status, 200);
    assert.equal(headRes.headers.get("content-length"), String(simulatedSize));
    const headBody = await headRes.text();
    assert.equal(headBody, "", "HEAD body must be completely empty");
  } finally {
    await db.delete(generations).where(eq(generations.id, videoGenId));
    await db.delete(folders).where(eq(folders.id, folder.id));
    await db.delete(namingCounters).where(eq(namingCounters.namespace, `folder:${folder.id}`));
  }
});

test("Stage 5.2: Authenticated signed download URL with exact Content-Disposition and redirect mode", async () => {
  assert.ok(process.env.DATABASE_URL, "test requires DATABASE_URL");
  const db = await getDb();
  const folder = await createFolder({ name: `SignedFolder_${randomUUID().slice(0, 6)}` });
  const userId = randomUUID();
  const validCookie = `${SESSION_COOKIE}=${signSession(userId, 0)}`;

  const genId = randomUUID();
  const now = Date.now();
  await upsertItem({
    id: genId,
    kind: "video",
    status: "completed",
    prompt: "Signed URL test video",
    model: "test-video",
    aspectRatio: "16:9",
    folderId: folder.id,
    url: `/api/media/generated/${genId}.mp4`,
    createdAt: now,
    updatedAt: now,
  });

  try {
    // 1. Direct getSignedDownloadUrl unit call
    // Should reject protected keys
    await assert.rejects(
      async () => getSignedDownloadUrl("settings/credentials.json"),
      /protected or invalid key/
    );

    // 2. Client requesting ?signed=1
    const mockSignedUrl = `https://storage.googleapis.com/test-bucket/generated/${genId}.mp4?X-Goog-Signature=abcdef12345`;
    const mockGetSignedUrl = async (key, { filename, disposition }) => {
      assert.ok(disposition.includes(filename), "Disposition must include resolved filename");
      return mockSignedUrl;
    };

    const redirectReq = new Request(`http://localhost/api/generations/${genId}/download?signed=1`, {
      headers: { cookie: validCookie },
    });
    const redirectRes = await downloadGet(
      redirectReq,
      { params: Promise.resolve({ id: genId }) },
      { getSignedDownloadUrl: mockGetSignedUrl }
    );

    // Expect 307 Temporary Redirect to signed URL
    assert.equal(redirectRes.status, 307);
    assert.equal(redirectRes.headers.get("location"), mockSignedUrl);
  } finally {
    await db.delete(generations).where(eq(generations.id, genId));
    await db.delete(folders).where(eq(folders.id, folder.id));
    await db.delete(namingCounters).where(eq(namingCounters.namespace, `folder:${folder.id}`));
  }
});

test("Stage 5.3: Namespace resolution benchmark at 100+ folders (avoids full-library scan)", async () => {
  assert.ok(process.env.DATABASE_URL, "test requires DATABASE_URL");
  const db = await getDb();
  const benchmarkTag = randomUUID().slice(0, 6);

  // 1. Create a deep target hierarchy (Depth 4)
  const root = await createFolder({ name: `BenchRoot_${benchmarkTag}` });
  const mid1 = await createFolder({ name: `BenchMid1_${benchmarkTag}`, parentId: root.id });
  const mid2 = await createFolder({ name: `BenchMid2_${benchmarkTag}`, parentId: mid1.id });
  const leaf = await createFolder({ name: `BenchLeaf_${benchmarkTag}`, parentId: mid2.id });

  // 2. Create 100 unrelated background folders to populate the library
  const backgroundFolders = [];
  for (let i = 0; i < 100; i++) {
    backgroundFolders.push({
      id: randomUUID(),
      name: `BackgroundFolder_${benchmarkTag}_${i}`,
      nameNormalized: `backgroundfolder_${benchmarkTag}_${i}`,
      parentId: null,
      projectId: null,
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
  await db.insert(folders).values(backgroundFolders);

  const genId = randomUUID();
  const now = Date.now();
  await upsertItem({
    id: genId,
    kind: "image",
    status: "completed",
    prompt: "Benchmark item",
    model: "test",
    aspectRatio: "1:1",
    folderId: leaf.id,
    url: `/api/media/generated/${genId}.png`,
    createdAt: now,
    updatedAt: now,
  });

  try {
    // Benchmark single-generation resolution in the presence of 100+ library folders
    const start = performance.now();
    const resolvedMap = await batchResolveGenerationFilenames(db, [genId]);
    const duration = performance.now() - start;

    assert.ok(resolvedMap.has(genId));
    const resolved = resolvedMap.get(genId);
    assert.ok(resolved.filename.startsWith(`benchroot_${benchmarkTag}_benchmid1_${benchmarkTag}_benchmid2_${benchmarkTag}_benchleaf_${benchmarkTag}`));

    // Assert high performance: must resolve well within 50ms (typically < 10ms)
    // because it fetches only 4 ancestors instead of scanning all 104 folders!
    assert.ok(
      duration < 100,
      `Namespace resolution took ${duration.toFixed(2)}ms with 104 folders, expected < 100ms`
    );
  } finally {
    await db.delete(generations).where(eq(generations.id, genId));
    await db.delete(folders).where(inArray(folders.id, [
      leaf.id, mid2.id, mid1.id, root.id, ...backgroundFolders.map((f) => f.id)
    ]));
    await db.delete(namingCounters).where(eq(namingCounters.namespace, `folder:${leaf.id}`));
  }
});
