import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  checkGenerationIndexes,
  checkStuckGenerations,
} from "@/lib/generation-health";
import {
  EXPECTED_GENERATION_INDEX_NAMES,
  GENERATION_INDEX_STATEMENTS,
} from "@/lib/generation-indexes";

function provider(rows) {
  return async () => ({ execute: async () => ({ rows }) });
}

test("generation index registry exactly matches schema declarations and optimizer statements", () => {
  const schema = readFileSync("src/lib/schema.js", "utf8");
  const block = schema.slice(schema.indexOf("export const generations"), schema.indexOf("export const depthWorkers"));
  const declared = [...block.matchAll(/index\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.deepEqual(declared, EXPECTED_GENERATION_INDEX_NAMES);
  for (const name of EXPECTED_GENERATION_INDEX_NAMES) {
    assert.equal(
      GENERATION_INDEX_STATEMENTS.filter((statement) => statement.includes(` ${name}\n`)).length,
      1,
      `${name} needs exactly one online-safe optimizer statement`
    );
  }
});

test("generation index health reports missing and invalid indexes", async () => {
  const rows = EXPECTED_GENERATION_INDEX_NAMES.slice(1).map((name) => ({ name, valid: true }));
  rows.find((row) => row.name === "generations_queue_idx").valid = false;
  const result = await checkGenerationIndexes(provider(rows));
  assert.equal(result.status, "error");
  assert.match(result.detail, /missing: generations_created_at_idx/);
  assert.match(result.detail, /invalid: generations_queue_idx/);
});

test("generation index health is ok only when every expected index is valid", async () => {
  const rows = EXPECTED_GENERATION_INDEX_NAMES.map((name) => ({ name, valid: true }));
  assert.deepEqual(await checkGenerationIndexes(provider(rows)), {
    status: "ok",
    detail: "10/10 expected indexes valid",
  });
});

test("stuck generation summary exposes counts and ages, never row ids", async () => {
  const now = 2_000_000;
  const result = await checkStuckGenerations(
    provider([
      { kind: "image", count: 2, oldest_updated_at: now - 20 * 60_000 },
      { kind: "video", count: 1, oldest_updated_at: now - 50 * 60_000 },
    ]),
    now
  );
  assert.equal(result.status, "error");
  assert.equal(result.detail, "3 stuck — image: 2 (oldest 20m); video: 1 (oldest 50m)");
});

test("stuck generation health is ok for an empty aggregate", async () => {
  assert.deepEqual(await checkStuckGenerations(provider([]), 2_000_000), {
    status: "ok",
    detail: "No stuck running generations",
  });
});
