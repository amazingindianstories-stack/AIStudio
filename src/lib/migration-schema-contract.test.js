import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync("src/app/api/admin/migrate-schema/route.js", "utf8");

test("generation migration verifies every generation column it adds", () => {
  const addedColumns = [...route.matchAll(
    /alter table generations add column if not exists ([a-z_]+)/gi
  )].map((match) => match[1]);
  assert.ok(addedColumns.length > 0);

  const verification = route.match(
    /column_name in \(([\s\S]*?)\);\s*`\);/
  )?.[1] ?? "";
  const verifiedColumns = [...verification.matchAll(/'([a-z_]+)'/g)]
    .map((match) => match[1]);

  assert.deepEqual(
    [...new Set(verifiedColumns)].sort(),
    [...new Set(addedColumns)].sort(),
    "COORDINATOR_STATEMENTS and coordinatorVerification must stay in sync"
  );

  const expectedCount = Number(route.match(/verified: coordCount === (\d+)/)?.[1]);
  assert.equal(expectedCount, new Set(verifiedColumns).size);
});

