import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");
const claim = read("src/app/api/worker/depth/claim/route.js");
const heartbeat = read("src/app/api/worker/depth/heartbeat/route.js");
const progress = read("src/app/api/worker/depth/progress/route.js");
const upload = read("src/app/api/worker/depth/upload-url/route.js");
const complete = read("src/app/api/worker/depth/complete/route.js");
const cron = read("src/app/api/cron/depth-reconciliation/route.js");
const schedule = read("vercel.json");

test("depth worker protocol carries fencing claims end to end", () => {
  assert.match(claim, /protocolVersion/);
  assert.match(claim, /claimId/);
  assert.match(heartbeat, /currentClaimId/);
  assert.match(heartbeat, /protocolVersion/);
  for (const route of [progress, upload, complete]) {
    assert.match(route, /claimId/);
    assert.match(route, /STALE_CLAIM/);
    assert.match(route, /status:\s*409/);
  }
  assert.match(upload, /depth-output\/\$\{jobId\}\/\$\{claimId\}\.mp4/);
});

test("depth reconciliation is scheduled and fails closed", () => {
  assert.match(cron, /verifyCronSecret\(request\)/);
  assert.match(cron, /reapStaleDepthJobs\(\{ force: true \}\)/);
  assert.match(cron, /status:\s*401/);
  assert.doesNotMatch(cron, /jobId|claimId|prompt|credentials/);
  assert.match(schedule, /api\/cron\/depth-reconciliation/);
});
