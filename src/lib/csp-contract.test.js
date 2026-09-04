import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import nextConfig from "../../next.config.js";

test("security headers expose a report-only CSP with the required baseline", async () => {
  const rules = await nextConfig.headers();
  const headers = new Map(rules[0].headers.map(({ key, value }) => [key, value]));
  const policy = headers.get("Content-Security-Policy-Report-Only");

  assert.ok(policy);
  assert.equal(headers.has("Content-Security-Policy"), false);
  for (const directive of [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "report-uri /api/security/csp-report",
  ]) assert.match(policy, new RegExp(directive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("the browser report endpoint is deliberately public and bounded", () => {
  const middleware = readFileSync("src/middleware.js", "utf8");
  const route = readFileSync("src/app/api/security/csp-report/route.js", "utf8");
  assert.match(middleware, /pathname === "\/api\/security\/csp-report"/);
  assert.match(route, /MAX_CSP_REPORT_BYTES/);
  assert.match(route, /parseCspReports/);
  assert.match(route, /status: 204/);
  assert.doesNotMatch(route, /logActivity|generations|users|cookies/);
});
