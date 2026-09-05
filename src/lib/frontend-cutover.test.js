import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";

const root = process.cwd();

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      [
        "node_modules", ".git", ".next", ".agents", ".claude", ".codex",
        ".council", ".vercel", "dist", "venv", ".venv",
      ].includes(entry.name)
    ) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    else files.push(target);
  }
  return files;
}

test("the active browser entrypoint is Vite with React Router routes", async () => {
  const source = await readFile(path.join(root, "src/main.jsx"), "utf8");
  assert.match(source, /BrowserRouter/);
  for (const route of ['path="/"', 'path="/login"', 'path="/admin"']) {
    assert.match(source, new RegExp(route.replace("/", "\\/")));
  }
  assert.doesNotMatch(source, /next\//);
});

test("active frontend modules contain no Next imports or client directives", async () => {
  const roots = ["src/pages", "src/components"];
  const files = [path.join(root, "src/main.jsx")];
  for (const directory of roots) files.push(...await walk(path.join(root, directory)));
  for (const file of files.filter((candidate) => /\.(js|jsx)$/.test(candidate))) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /from\s+["']next\//, path.relative(root, file));
    assert.doesNotMatch(source, /^["']use client["'];/m, path.relative(root, file));
  }
});

test("the browser API client uses Vite configuration and credentials", async () => {
  const source = await readFile(path.join(root, "src/lib/api.js"), "utf8");
  assert.match(source, /import\.meta\.env\.VITE_API_URL/);
  assert.match(source, /credentials:\s*"include"/);
  assert.doesNotMatch(source, /NEXT_PUBLIC_/);
});

test("Vercel is configured as a static SPA with no cron ownership", async () => {
  const config = JSON.parse(await readFile(path.join(root, "vercel.json"), "utf8"));
  assert.equal(config.framework, "vite");
  assert.equal(config.outputDirectory, "dist");
  assert.equal(config.crons, undefined);
  assert.ok(config.rewrites.some((rewrite) => rewrite.destination === "/index.html"));
  assert.ok(config.headers.length > 0);
  assert.doesNotMatch(JSON.stringify(config), /(?:connect|img|media)-src[^\"]*https:/);
  const source = await readFile(path.join(root, "vite.config.mjs"), "utf8");
  assert.match(source, /exactOrigin\(env\.VITE_API_URL/);
  assert.match(source, /https:\/\/storage\.googleapis\.com/);
  assert.match(source, /Content-Security-Policy/);
  assert.doesNotMatch(source, /(?:connect|img|media)-src[^`\n]*https:/);
});

test("Vitest owns unit execution and Railway IaC is the only TypeScript source", async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(packageJson.scripts.test, "vitest run");
  assert.equal(packageJson.scripts.build, "vite build");
  const files = await walk(root);
  assert.deepEqual(
    files.filter((file) => /\.(ts|tsx)$/.test(file)).map((file) => path.relative(root, file)),
    [path.join(".railway", "railway.ts")],
  );
  const retiredRunner = new RegExp(["node", "test"].join(":"));
  for (const file of files.filter((candidate) => candidate.endsWith(".test.js"))) {
    assert.doesNotMatch(await readFile(file, "utf8"), retiredRunner, path.relative(root, file));
  }
});
