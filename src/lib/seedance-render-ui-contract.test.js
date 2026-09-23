import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("both composer settings surfaces expose Render and Bitrate controls and summaries", () => {
  for (const file of ["src/components/ComposerControls.jsx", "src/components/PromptComposer.jsx"]) {
    const source = readFileSync(file, "utf8");
    assert.match(source, /label="Render"/);
    assert.match(source, /label="Bitrate"/);
    assert.match(source, /s\.draftMode \? "Draft" : "Final"/);
    assert.match(source, /s\.bitrateMode === "standard" \? "Standard" : "High"/);
  }
});

test("detail labels are conditional so legacy rows remain unlabeled", () => {
  const source = readFileSync("src/components/DetailModal.jsx", "utf8");
  assert.match(source, /item\.draftMode != null/);
  assert.match(source, /label="Render"/);
  assert.match(source, /item\.bitrateMode != null/);
  assert.match(source, /label="Bitrate"/);
});

test("queue execution forwards persisted settings through the shared candidate input", () => {
  const source = readFileSync("src/app/api/queue/execute/route.js", "utf8");
  assert.match(source, /draftMode: base\.draftMode === true/);
  assert.match(source, /bitrateMode: base\.bitrateMode/);
  assert.match(source, /createVideoTask\(taskInput\(candidateSeed\)\)/);
});
