import test from "node:test";
import assert from "node:assert/strict";
import { uploadOriginalReference } from "./client-reference-upload.js";

const file = { type: "image/png" };

test("reports a presign failure and does not attempt the direct PUT", async (t) => {
  const fetch = t.mock.fn(async () => ({ ok: false, json: async () => ({ error: "Upload is unavailable." }) }));
  t.mock.method(globalThis, "fetch", fetch);
  await assert.rejects(uploadOriginalReference(file), /Upload is unavailable/);
  assert.equal(fetch.mock.callCount(), 1);
});

test("uses the exact MIME type and reports a direct PUT failure", async (t) => {
  const fetch = t.mock.fn(async (url, options) => {
    if (url === "/api/uploads/presign") {
      return { ok: true, json: async () => ({ key: "uploads/image-reference/u-id", uploadUrl: "https://storage.example/signed" }) };
    }
    assert.equal(options.method, "PUT");
    assert.equal(options.headers["Content-Type"], file.type);
    return { ok: false };
  });
  t.mock.method(globalThis, "fetch", fetch);
  await assert.rejects(uploadOriginalReference(file), /Reference upload failed/);
  assert.equal(fetch.mock.callCount(), 2);
});
