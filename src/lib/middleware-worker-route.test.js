import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("queue worker route bypasses cookie middleware but keeps route auth", () => {
  const middleware = readFileSync("src/middleware.js", "utf8");
  const queueRoute = readFileSync("src/app/api/queue/execute/route.js", "utf8");

  assert.match(middleware, /pathname === ["']\/api\/queue\/execute["']/);
  assert.match(queueRoute, /x-generation-worker-secret/);
  assert.match(queueRoute, /GENERATION_WORKER_SECRET/);
});
