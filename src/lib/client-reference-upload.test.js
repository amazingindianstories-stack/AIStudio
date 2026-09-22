import test from "node:test";
import assert from "node:assert/strict";
import { uploadContentType, uploadOriginalReference } from "./client-reference-upload.js";

const file = { type: "image/png" };

test("reports a presign failure and does not attempt the direct PUT", async (t) => {
  const fetch = t.mock.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: "Upload is unavailable." }) }));
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
  await assert.rejects(uploadOriginalReference(file), /Storage rejected the upload/);
  assert.equal(fetch.mock.callCount(), 2);
});

test("normalizes browser MIME aliases and infers missing types from filenames", () => {
  assert.equal(uploadContentType({ name: "photo.JPG", type: "image/jpg" }), "image/jpeg");
  assert.equal(uploadContentType({ name: "portrait.heic", type: "" }), "image/heic");
  assert.equal(uploadContentType({ name: "voice.m4a", type: "" }), "audio/mp4");
});

test("requests a fresh signed URL after a transient storage failure", async (t) => {
  const urls = [];
  let presigns = 0;
  const fetch = t.mock.fn(async (url) => {
    if (url === "/api/uploads/presign") {
      presigns += 1;
      return { ok: true, json: async () => ({ key: `uploads/image-reference/key-${presigns}`, uploadUrl: `https://storage.example/${presigns}` }) };
    }
    urls.push(url);
    return { ok: urls.length > 1, status: urls.length > 1 ? 200 : 503 };
  });
  t.mock.method(globalThis, "fetch", fetch);
  assert.equal(await uploadOriginalReference(file), "/api/media/uploads/image-reference/key-2");
  assert.deepEqual(urls, ["https://storage.example/1", "https://storage.example/2"]);
});
