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
