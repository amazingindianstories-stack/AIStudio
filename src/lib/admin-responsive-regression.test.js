import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const admin = readFileSync("src/components/AdminDashboard.jsx", "utf8");

test("Admin wide data tables remain reachable on narrow screens", () => {
  assert.ok(
    (admin.match(/scroll-thin overflow-x-auto rounded-xl border border-line/g) || []).length >= 3,
    "logs, activity, and pricing tables must scroll horizontally"
  );
  assert.match(admin, /min-w-\[900px\]/);
  assert.ok((admin.match(/min-w-\[680px\]/g) || []).length >= 2);
});
