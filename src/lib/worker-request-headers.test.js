import test from "node:test";
import assert from "node:assert/strict";
import { workerRequestHeaders } from "./worker-request-headers.js";
import { runCoordinatorOnce } from "../worker/generation-worker.js";
import { runExportOnce } from "../worker/media-export-worker.js";

test("worker authentication remains present without preview protection", () => {
  assert.deepEqual(workerRequestHeaders("worker-secret", {}), {
    "Content-Type": "application/json", "x-generation-worker-secret": "worker-secret",
  });
});
test("both worker control paths authenticate protected previews without logging credentials", async () => {
  const previous = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET = "preview-bypass";
  const requests = []; const logs = [];
  const fetchImpl = async (_url, options) => { requests.push(options); return { ok: false, status: 401 }; };
  const logger = { error: (entry) => logs.push(entry) };
  try {
    const queued = { id: "fixture", status: "queued" };
    await runCoordinatorOnce({ select: async () => [queued], claim: async () => queued,
      release: async () => {}, schedule: async () => {}, loadItem: async () => undefined,
      baseUrl: "https://preview.example", secret: "worker-secret", fetchImpl, logger });
    await runExportOnce({ claim: async () => ({ id: "export", items: [] }), fail: async () => {},
      baseUrl: "https://preview.example", secret: "worker-secret", fetchImpl, logger });
    assert.equal(requests.length, 2);
    for (const { headers } of requests) {
      assert.equal(headers["x-generation-worker-secret"], "worker-secret");
      assert.equal(headers["x-vercel-protection-bypass"], "preview-bypass");
    }
    assert.ok(!JSON.stringify(logs).includes("preview-bypass"));
    assert.ok(!JSON.stringify(logs).includes("worker-secret"));
  } finally {
    if (previous === undefined) delete process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    else process.env.VERCEL_AUTOMATION_BYPASS_SECRET = previous;
  }
});
