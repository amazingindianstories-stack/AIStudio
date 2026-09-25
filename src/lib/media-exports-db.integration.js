import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import { getDb } from "./db.js";
import { appendMediaExportItems, createMediaExport, finalizeMediaExport, getOwnedMediaExport } from "./media-exports-db.js";
import { generations, mediaExportItems, mediaExports } from "./schema.js";

test("media export ownership, validation, deduplication, order, and finalization", async () => {
  assert.ok(process.env.DATABASE_URL, "test:db requires a disposable PostgreSQL database");
  const db = await getDb(); const userId = randomUUID(); const otherUserId = randomUUID();
  const ids = [randomUUID(), randomUUID(), randomUUID()]; const now = Date.now();
  await db.insert(generations).values([
    { id: ids[0], kind: "image", status: "completed", prompt: "a", model: "test", aspectRatio: "1:1", url: `/api/media/generated/${ids[0]}.png`, createdAt: now, updatedAt: now },
    { id: ids[1], kind: "video", status: "completed", prompt: "b", model: "test", aspectRatio: "1:1", url: `/api/media/generated/${ids[1]}.mp4`, createdAt: now, updatedAt: now },
    { id: ids[2], kind: "image", status: "completed", prompt: "c", model: "test", aspectRatio: "1:1", url: `/api/media/generated/${ids[2]}.webp`, createdAt: now, updatedAt: now },
  ]);
  let exportId;
  try {
    exportId = (await createMediaExport(userId, now)).id;
    assert.equal(await getOwnedMediaExport(exportId, otherUserId), undefined);
    const first = await appendMediaExportItems(exportId, userId, [ids[2], ids[1], ids[2], randomUUID()]);
    assert.equal(first.accepted, 1); assert.equal(first.rejected.length, 2);
    const second = await appendMediaExportItems(exportId, userId, [ids[0], ids[2]]);
    assert.equal(second.accepted, 1); assert.equal(second.totalItems, 2);
    const items = await db.select().from(mediaExportItems).where(eq(mediaExportItems.exportId, exportId)).orderBy(asc(mediaExportItems.position));
    assert.deepEqual(items.map((item) => item.generationId), [ids[2], ids[0]]);
    await assert.rejects(finalizeMediaExport(exportId, otherUserId), /EXPORT_NOT_FINALIZABLE/);
    assert.equal((await finalizeMediaExport(exportId, userId)).status, "queued");
    await assert.rejects(appendMediaExportItems(exportId, userId, [ids[0]]), /EXPORT_NOT_DRAFT/);
  } finally {
    if (exportId) await db.delete(mediaExports).where(eq(mediaExports.id, exportId));
    await db.delete(generations).where(inArray(generations.id, ids));
  }
});
