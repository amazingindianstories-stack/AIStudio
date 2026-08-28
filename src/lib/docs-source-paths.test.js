import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT_DOCS = ["CLAUDE.md", "BACKEND_AUDIT.md", "progress.md"];

async function markdownFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(relative)));
    else if (entry.name.endsWith(".md")) files.push(relative);
  }
  return files;
}

test("maintained docs do not point at retired TypeScript source extensions", async () => {
  const files = [...ROOT_DOCS, ...(await markdownFiles("docs"))];
  const stale = [];
  const sourcePath = /(?:src|scripts|backend)\/[A-Za-z0-9_./%*\[\]-]+\.tsx?\b/g;
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(sourcePath)) {
      stale.push(`${file}:${text.slice(0, match.index).split("\n").length}:${match[0]}`);
    }
  }
  assert.deepEqual(
    stale,
    [],
    `Update source links to the repository's current .js/.jsx files:\n${stale.join("\n")}`
  );
});
