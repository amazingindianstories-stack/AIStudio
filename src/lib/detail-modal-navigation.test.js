import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("DetailModal keeps project navigation predicates inside filter callback", () => {
  const source = readFileSync("src/components/DetailModal.jsx", "utf8");
  const start = source.indexOf("const navigableItems = useMemo(");
  const end = source.indexOf("\n\n  useEffect(() =>", start);
  const block = source.slice(start, end);

  assert.match(block, /items\.filter\(\s*\(candidate\)\s*=>/s);
  assert.match(block, /candidate\.projectId === activeProjectId/);
  assert.match(block, /candidate\.projectId === activeProjectId[\s\S]*\n\s+\),/);
});
