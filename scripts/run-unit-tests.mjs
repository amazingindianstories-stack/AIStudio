import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

async function walk(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await walk(file));
    else out.push(file);
  }
  return out;
}

const root = process.cwd();
const sourceTests = (await walk(path.join(root, "src")))
  .filter((file) => file.endsWith(".test.js"))
  .sort();
const forbiddenScriptTests = (await walk(path.join(root, "scripts")))
  .filter((file) => file.endsWith(".test.js"));

if (forbiddenScriptTests.length) {
  console.error("Unit tests must live under src/, not scripts/ (which contains live probes):");
  for (const file of forbiddenScriptTests) console.error(`- ${path.relative(root, file)}`);
  process.exit(1);
}
if (!sourceTests.length) {
  console.error("No src/**/*.test.js files were discovered.");
  process.exit(1);
}

const executable = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const result = spawnSync(
  executable,
  ["--tsconfig", "jsconfig.json", "--test", ...sourceTests.map((file) => path.relative(root, file))],
  { cwd: root, stdio: "inherit" }
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
