import assert from "node:assert/strict";
import test from "node:test";
import { createResumableWriter, GCS_UPLOAD_CHUNK_BYTES } from "./gcs-resumable-writer";

test("resumable writer bounds buffering, uses 8 MiB chunks, and accepts 308", async () => {
  const calls = [];
  const writer = createResumableWriter("https://upload.invalid/session", { fetchImpl: async (_url, options) => { calls.push(options); return { status: calls.length < 2 ? 308 : 200, ok: calls.length >= 2 }; } });
  await writer.write(new Uint8Array(GCS_UPLOAD_CHUNK_BYTES));
  assert.equal(calls.length, 0, "one full chunk is retained until it is known not to be final");
  await writer.write(new Uint8Array(9));
  assert.equal(calls.length, 1); assert.equal(calls[0].body.length, GCS_UPLOAD_CHUNK_BYTES); assert.equal(calls[0].headers["Content-Range"], `bytes 0-${GCS_UPLOAD_CHUNK_BYTES - 1}/*`);
  assert.equal(writer.bufferedBytes, 9);
  const bytes = await writer.finish(); assert.equal(bytes, GCS_UPLOAD_CHUNK_BYTES + 9); assert.equal(calls[1].headers["Content-Range"], `bytes ${GCS_UPLOAD_CHUNK_BYTES}-${GCS_UPLOAD_CHUNK_BYTES + 8}/${GCS_UPLOAD_CHUNK_BYTES + 9}`);
});

test("resumable writer rejects a non-308 intermediate response", async () => {
  const writer = createResumableWriter("x", { chunkBytes: 4, fetchImpl: async () => ({ status: 200, ok: true }) });
  await assert.rejects(writer.write(new Uint8Array(5)), /failed \(200\)/);
});
