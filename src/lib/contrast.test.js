import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// Small text (9-10px) must use the text-muted token, not white at 30-40% opacity (about 3:1 on ink-800).
// Disabled controls, separators and placeholders are exempt.
function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) yield* walk(file);
    else if (file.endsWith(".jsx")) yield file;
  }
}

test("9-10px text does not use low-contrast white/30-40", () => {
  const offenders = [];
  for (const file of walk(path.join(process.cwd(), "src"))) {
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
      if (!/text-\[(9|10)px\]/.test(line)) return;
      if (!/(?<![:\w/-])text-white\/(30|35|40)(?![\d/])/.test(line)) return;
      if (/placeholder:|disabled:/.test(line)) return;
      offenders.push(`${path.relative(process.cwd(), file)}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, [], "use text-muted instead of text-white/30-40 on small text");
});
