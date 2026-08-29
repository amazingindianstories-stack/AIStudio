import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync("src/app/api/generate/video/status/route.js", "utf8");
const cron = readFileSync("src/app/api/cron/video-reconciliation/route.js", "utf8");

test("transient video polls use sanitized HTTP-200 retry fields", () => {
  assert.match(route, /transientPollError: true/);
  assert.match(route, /pollErrorCount: outcome\.pollErrorCount/);
  assert.match(route, /retryAfterMs: outcome\.retryAfterMs/);
  assert.doesNotMatch(route, /status:\s*502|error\.message|String\(error\)/);
});

test("video reconciliation route fails closed through shared cron authentication", () => {
  assert.match(cron, /verifyCronSecret\(request\)/);
  assert.match(cron, /status:\s*401/);
  assert.doesNotMatch(cron, /taskId|prompt|credentials|provider/);
});
