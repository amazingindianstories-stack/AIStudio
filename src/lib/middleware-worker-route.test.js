import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("worker and callback routes cross middleware only to reach route-level secrets", () => {
  const middleware = readFileSync(new URL("../middleware.js", import.meta.url), "utf8");
  const queueRoute = readFileSync(new URL("../app/api/queue/execute/route.js", import.meta.url), "utf8");
  const callbackRoute = readFileSync(new URL("../app/api/webhooks/seedance/route.js", import.meta.url), "utf8");
  assert.match(middleware, /pathname === "\/api\/queue\/execute"/);
  assert.match(middleware, /pathname === "\/api\/webhooks\/seedance"/);
  assert.match(queueRoute, /GENERATION_WORKER_SECRET/);
  assert.match(callbackRoute, /SEEDANCE_CALLBACK_SECRET/);
});
