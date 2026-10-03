import assert from "node:assert/strict";
import test from "node:test";
import { runExportOnce } from "./media-export-worker";

test("export worker reads sources sequentially, warns for permanent misses, and completes", async () => {
  const job = { id: "e1", items: [{ generationId: "missing", sourceKey: "a.png", filename: "1-missing" }, { generationId: "ok", sourceKey: "b.png", filename: "2-ok" }] };
  const heartbeats = []; let completed; let activeGets = 0; let peakGets = 0;
  const fetchImpl = async (url, options = {}) => {
    if (url.includes("/access")) {
      const body = JSON.parse(options.body);
      if (body.action === "upload") return { ok: true, json: async () => ({ key: "exports/u/e1.zip", url: "upload" }) };
      return { ok: true, json: async () => ({ url: body.generationId === "missing" ? "source-missing" : "source-ok" }) };
    }
    if (url === "source-missing") return { ok: false, status: 404, headers: new Headers() };
    if (url === "source-ok" && options.method === "HEAD") return { ok: true, status: 200, headers: new Headers({ "content-length": "3", "content-type": "image/png" }) };
    if (url === "source-ok") { activeGets += 1; peakGets = Math.max(peakGets, activeGets); const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); activeGets -= 1; } }); return { ok: true, status: 200, body }; }
    if (url === "upload") return { ok: true, status: 200 };
    throw new Error(url);
  };
  const result = await runExportOnce({ claim: async () => job, heartbeat: async (_id, _owner, value) => heartbeats.push(value), complete: async (_id, _owner, value) => { completed = value; }, fail: async () => {}, fetchImpl, baseUrl: "https://app", secret: "secret", logger: { error() {} } });
  assert.equal(result.completed, 1); assert.equal(result.skipped, 1); assert.equal(peakGets, 1); assert.equal(completed.warnings[0].id, "missing"); assert.ok(heartbeats.some((value) => value.processedItems === 2));
});

test("export worker returns a failed attempt so the database can retry the whole archive", async () => {
  let failure;
  const result = await runExportOnce({ claim: async () => ({ id: "e2", items: [] }), fail: async (_id, _owner, error) => { failure = error; }, fetchImpl: async () => { throw new Error("transport broke"); }, baseUrl: "https://app", secret: "secret", logger: { error() {} } });
  assert.equal(result.errors, 1); assert.match(failure, /transport broke/);
});

test("export worker respects manifestVersion 2 verbatim names and guards against double extensions in v1", async () => {
  const jobV2 = {
    id: "e-v2",
    manifestVersion: 2,
    items: [
      { generationId: "g1", sourceKey: "gen1.png", filename: "my_folder_0001.png" },
    ],
  };

  const jobV1NoExt = {
    id: "e-v1-noext",
    manifestVersion: 1,
    items: [
      { generationId: "g2", sourceKey: "gen2.png", filename: "my_folder_0002" },
    ],
  };

  const jobV1WithExt = {
    id: "e-v1-withext",
    manifestVersion: 1,
    items: [
      { generationId: "g3", sourceKey: "gen3.png", filename: "my_folder_0003.png" },
    ],
  };

  const uploadPayloads = [];
  const fetchImpl = async (url, options = {}) => {
    if (url.includes("/access")) {
      const body = JSON.parse(options.body);
      if (body.action === "upload") return { ok: true, json: async () => ({ key: "exports/u/test.zip", url: "upload" }) };
      return { ok: true, json: async () => ({ url: "source-ok" }) };
    }
    if (url === "source-ok" && options.method === "HEAD") return { ok: true, status: 200, headers: new Headers({ "content-length": "4", "content-type": "image/png" }) };
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

  const noop = async () => {};

  // Test 1: v2 preserves exact filename
  uploadPayloads.length = 0;
  const resV2 = await runExportOnce({
    claim: async () => jobV2,
    heartbeat: noop,
    complete: noop,
    fail: noop,
    fetchImpl,
    baseUrl: "https://app",
    secret: "secret",
    logger: { error() {} },
  });
  assert.equal(resV2.completed, 1);
  const v2ZipStr = uploadPayloads.join("");
  assert.ok(v2ZipStr.includes("my_folder_0001.png"), "v2 includes verbatim filename");

  // Test 2: v1 appends extension when missing
  uploadPayloads.length = 0;
  const resV1NoExt = await runExportOnce({
    claim: async () => jobV1NoExt,
    heartbeat: noop,
    complete: noop,
    fail: noop,
    fetchImpl,
    baseUrl: "https://app",
    secret: "secret",
    logger: { error() {} },
  });
  assert.equal(resV1NoExt.completed, 1);
  const v1NoExtZipStr = uploadPayloads.join("");
  assert.ok(v1NoExtZipStr.includes("my_folder_0002.png"), "v1 appends extension when missing");

  // Test 3: v1 guards against double extension when filename already has it
  uploadPayloads.length = 0;
  const resV1WithExt = await runExportOnce({
    claim: async () => jobV1WithExt,
    heartbeat: noop,
    complete: noop,
    fail: noop,
    fetchImpl,
    baseUrl: "https://app",
    secret: "secret",
    logger: { error() {} },
  });
  assert.equal(resV1WithExt.completed, 1);
  const v1WithExtZipStr = uploadPayloads.join("");
  assert.ok(v1WithExtZipStr.includes("my_folder_0003.png"), "v1 keeps existing extension");
  assert.ok(!v1WithExtZipStr.includes("my_folder_0003.png.png"), "v1 avoids double extension");
});
