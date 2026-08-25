import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const tracker = readFileSync(
  new URL("../../docs/audit/remediation-tracker.md", import.meta.url),
  "utf8"
);

const PREFIXES = [
  "MERGE", "SEC", "COST", "REL", "MIG", "DRIFT", "VER", "ARCH", "DX", "QUAL",
];
const EXPECTED_IDS = [
  "MERGE-01",
  ...Array.from({ length: 8 }, (_, i) => `SEC-${String(i + 1).padStart(2, "0")}`),
  ...Array.from({ length: 7 }, (_, i) => `COST-${String(i + 1).padStart(2, "0")}`),
  ...Array.from({ length: 9 }, (_, i) => `REL-${String(i + 1).padStart(2, "0")}`),
  ...Array.from({ length: 10 }, (_, i) => `MIG-${String(i + 1).padStart(2, "0")}`),
  ...Array.from({ length: 8 }, (_, i) => `DRIFT-${String(i + 1).padStart(2, "0")}`),
  ...Array.from({ length: 12 }, (_, i) => `VER-${String(i + 1).padStart(2, "0")}`),
  ...Array.from({ length: 8 }, (_, i) => `ARCH-${String(i + 1).padStart(2, "0")}`),
  ...Array.from({ length: 11 }, (_, i) => `DX-${String(i + 1).padStart(2, "0")}`),
  ...Array.from({ length: 6 }, (_, i) => `QUAL-${String(i + 1).padStart(2, "0")}`),
].sort();
const VALID_STATES = new Set([
  "open", "in_progress", "blocked", "monitoring", "resolved", "deferred",
]);

test("remediation tracker contains the PDF's exact 80 stable issue IDs once", () => {
  assert.equal(EXPECTED_IDS.length, 80);
  const register = tracker.slice(tracker.indexOf("## Full issue register"));
  const found = [...register.matchAll(
    /^\| ((?:MERGE|SEC|COST|REL|MIG|DRIFT|VER|ARCH|DX|QUAL)-\d{2}) \|/gm
  )].map((match) => match[1]).sort();
  assert.deepEqual(found, EXPECTED_IDS);
  assert.equal(new Set(found).size, found.length);
});

test("every remediation row uses a supported state", () => {
  const register = tracker.slice(tracker.indexOf("## Full issue register"));
  const rows = register.split("\n").filter((line) =>
    PREFIXES.some((prefix) => line.startsWith(`| ${prefix}-`))
  );
  assert.equal(rows.length, 80);
  for (const row of rows) {
    const cells = row.split("|").map((cell) => cell.trim());
    assert.ok(VALID_STATES.has(cells[4]), `${cells[1]} has invalid state ${cells[4]}`);
  }
});
