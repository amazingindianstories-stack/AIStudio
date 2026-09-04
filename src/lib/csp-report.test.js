import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptedCspContentType,
  MAX_CSP_REPORT_BYTES,
  MAX_CSP_REPORTS,
  parseCspReports,
} from "./csp-report";

test("legacy CSP reports retain diagnostics but strip signed URLs and object paths", () => {
  const [report] = parseCspReports(JSON.stringify({
    "csp-report": {
      "document-uri": "https://veevee.ai/admin?token=secret",
      "blocked-uri": "https://storage.googleapis.com/private-bucket/secret-object.png?X-Goog-Signature=secret",
      "source-file": "https://veevee.ai/_next/static/chunks/app.js?build=secret",
      "effective-directive": "img-src-elem",
      "violated-directive": "img-src 'self'",
      "status-code": 200,
      disposition: "report",
      sample: "private prompt text",
    },
  }), "application/csp-report");

  assert.deepEqual(report, {
    event: "csp_violation",
    effectiveDirective: "img-src-elem",
    violatedDirective: "img-src 'self'",
    disposition: "report",
    statusCode: 200,
    blockedOrigin: "https://storage.googleapis.com",
    documentPath: "/admin",
    source: "/_next/static/chunks/app.js",
  });
  assert.doesNotMatch(JSON.stringify(report), /secret|private-bucket|secret-object|prompt/i);
});

test("Reporting API batches are bounded and sanitized", () => {
  const payload = Array.from({ length: MAX_CSP_REPORTS + 5 }, (_, index) => ({
    type: "csp-violation",
    body: {
      effectiveDirective: "script-src-elem",
      blockedURL: index % 2 ? "inline" : "https://evil.invalid/path?q=secret",
      documentURL: `https://veevee.ai/login?attempt=${index}`,
      disposition: "enforce",
    },
  }));
  const reports = parseCspReports(JSON.stringify(payload), "application/reports+json; charset=utf-8");
  assert.equal(reports.length, MAX_CSP_REPORTS);
  assert.equal(reports[0].blockedOrigin, "https://evil.invalid");
  assert.equal(reports[1].blockedOrigin, "inline");
  assert.ok(reports.every((report) => report.documentPath === "/login"));
});

test("external source paths and unknown document identifiers never reach logs", () => {
  const [report] = parseCspReports(JSON.stringify({
    "csp-report": {
      "document-uri": "https://veevee.ai/api/media/private/user/object.png?signature=secret",
      "source-file": "https://storage.googleapis.com/private-bucket/private-user/object.js?token=secret",
      "blocked-uri": "inline",
      "effective-directive": "script-src-elem",
    },
  }), "application/csp-report");
  assert.equal(report.documentPath, "/api/[redacted]");
  assert.equal(report.source, "https://storage.googleapis.com");
  assert.doesNotMatch(JSON.stringify(report), /private|object|signature|secret|token/i);
});

test("Reporting API ignores non-CSP report types", () => {
  const payload = JSON.stringify([
    { type: "deprecation", body: { message: "not a CSP violation" } },
    { type: "csp-violation", body: { effectiveDirective: "object-src", blockedURL: "inline" } },
  ]);
  const reports = parseCspReports(payload, "application/reports+json");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].effectiveDirective, "object-src");
});

test("CSP report parsing rejects unsupported, malformed, empty, and oversized payloads", () => {
  assert.equal(acceptedCspContentType("application/csp-report; charset=utf-8"), true);
  assert.equal(acceptedCspContentType("application/json"), false);
  assert.throws(() => parseCspReports("{}", "application/json"), (error) => error.status === 415);
  assert.throws(() => parseCspReports("not json", "application/csp-report"), (error) => error.status === 400);
  assert.throws(() => parseCspReports("[]", "application/reports+json"), (error) => error.status === 400);
  assert.throws(
    () => parseCspReports(JSON.stringify({ value: "x".repeat(MAX_CSP_REPORT_BYTES) }), "application/csp-report"),
    (error) => error.status === 413
  );
});
