import assert from "node:assert/strict";
import { test } from "vitest";
import { verifyCronSecret } from "./cron-auth.js";

function request(authorization) {
  return new Request("https://example.test/api/cron/login-attempts", {
    headers: authorization ? { authorization } : {},
  });
}

test("cron authentication fails closed without a configured secret", () => {
  assert.equal(verifyCronSecret(request("Bearer anything"), {}), false);
});

test("cron authentication rejects missing and incorrect authorization", () => {
  const env = { CRON_SECRET: "correct-secret" };
  assert.equal(verifyCronSecret(request(), env), false);
  assert.equal(verifyCronSecret(request("Bearer wrong-secret"), env), false);
});

test("cron authentication accepts the exact bearer secret", () => {
  assert.equal(
    verifyCronSecret(request("Bearer correct-secret"), { CRON_SECRET: "correct-secret" }),
    true
  );
});

