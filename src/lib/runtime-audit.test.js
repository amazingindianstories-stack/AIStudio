import assert from "node:assert/strict";
import test from "node:test";
import {
  activeDatabaseBackend,
  klingAuditResults,
  parseCsv,
  partialSubmissionCheck,
  sanitizeAuditDetail,
  spoolCheck,
} from "./runtime-audit";

test("runtime audit CSV parser follows RFC 4180 quotes, commas, and newlines", () => {
  const rows = parseCsv('a,b,c\r\n1,"two, \"\"quoted\"\"","line one\nline two"');
  assert.deepEqual(rows, [["a", "b", "c"], ["1", 'two, "quoted"', "line one\nline two"]]);
});

test("runtime audit detail redacts UUIDs, credentials, and line breaks", () => {
  const detail = sanitizeAuditDetail(
    "token=secret-value\nBearer abc 6a0b7185-f565-4eb2-9d30-63e0bae8e963"
  );
  assert.equal(detail.includes("secret-value"), false);
  assert.equal(detail.includes("abc"), false);
  assert.equal(detail.includes("6a0b7185"), false);
  assert.equal(detail.includes("\n"), false);
});

test("runtime audit spool diagnostic cleans success and forced-failure directories", async () => {
  assert.match(await spoolCheck(), /metadata only/);
});

test("runtime audit partial submission diagnostic is controlled and provider-free", async () => {
  assert.match(await partialSubmissionCheck(), /2\/3 partial submission/);
});

test("runtime audit reports only the sanitized no-task failure cause", () => {
  const checks = klingAuditResults({ noTaskCreated: false, requestSafetyPass: true });
  assert.deepEqual(checks.map(({ id, status }) => ({ id, status })), [
    { id: "ARCH-04", status: "error" },
    { id: "VER-08", status: "error" },
    { id: "VER-10", status: "unknown" },
  ]);
  assert.match(checks[0].detail, /task-list stability could not be proven/);
  assert.equal(checks.some((check) => /task[_ -]?id/i.test(check.detail)), false);
});

test("runtime audit keeps routing and resolution results independent", () => {
  const matrix = {};
  for (const model of ["kling-v3", "kling-v2-1"]) for (const resolution of ["1k", "2k"])
    for (const mode of ["t2i", "i2i"]) matrix[`${model}:${resolution}:${mode}`] = {
      resolutionRejected: model === "kling-v2-1" && resolution === "2k" && mode === "i2i",
      modelRejected: false,
      validationReachedN: !(model === "kling-v2-1" && resolution === "2k" && mode === "i2i"),
      rejectedWithoutTask: true,
    };
  matrix["kling-v3:2k:i2i"].resolutionRejected = true;
  const [routing, resolution, seed] = klingAuditResults({
    noTaskCreated: true, matrix, seedVerdict: "inconclusive",
  });
  assert.deepEqual([routing.status, resolution.status, seed.status], ["ok", "error", "unknown"]);
  assert.match(routing.detail, /2\/2/);
  assert.match(resolution.detail, /7\/8/);
  assert.match(resolution.detail, /kling-v3\[2k:i2i\]/);
  assert.match(seed.detail, /support remains disabled/);
});

test("runtime audit suppresses resolution when wire routing fails safely", () => {
  const matrix = {};
  for (const model of ["kling-v3", "kling-v2-1"]) for (const resolution of ["1k", "2k"])
    for (const mode of ["t2i", "i2i"]) matrix[`${model}:${resolution}:${mode}`] = {
      resolutionRejected: false, modelRejected: false, validationReachedN: true, rejectedWithoutTask: true,
    };
  matrix["kling-v2-1:1k:t2i"].modelRejected = true;
  const [routing, resolution] = klingAuditResults({
    noTaskCreated: true, matrix, seedVerdict: "inconclusive",
  });
  assert.equal(routing.status, "error");
  assert.equal(resolution.status, "unknown");
  assert.match(resolution.detail, /suppressed/);
  assert.match(routing.detail, /kling-v2-1\[1k:t2i\]/);
  assert.match(resolution.detail, /kling-v2-1\[1k:t2i\]/);
});

test("runtime audit names the active database mode without exposing connection data", () => {
  assert.equal(activeDatabaseBackend("cloud-sql"), "cloud-sql");
  assert.equal(activeDatabaseBackend(undefined), "direct-postgres");
  assert.equal(activeDatabaseBackend("postgresql://private"), "direct-postgres");
});
