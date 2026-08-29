import assert from "node:assert/strict";
import test from "node:test";
import { parseCsv, sanitizeAuditDetail } from "./runtime-audit";

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
