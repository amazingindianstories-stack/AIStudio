import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

test("package-project-zip never packages secret credentials or runtime .env files", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "veevee-package-guard-"));
  const zipPath = path.join(temporary, "source.zip");
  try {
  // Always inspect this tested source, never a stale archive from another release.
  execFileSync("python3", ["scripts/package-project-zip.py", "--output", zipPath,
    "--limit-bytes", "20000000"], { stdio: "pipe" });
  const output = execFileSync("unzip", ["-l", zipPath], { encoding: "utf8" });
  const lines = output.split("\n");

  const forbiddenFiles = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 4) {
      const fileName = parts.slice(3).join(" ");
      const base = path.basename(fileName);
      if (
        (fileName.includes(".env") && !fileName.endsWith(".example") && !fileName.endsWith(".sample")) ||
        base === ".worker-id" ||
        base === ".higgsfield-mcp-token.json" ||
        base.endsWith(".pem") ||
        base.endsWith(".key")
      ) {
        forbiddenFiles.push(fileName);
      }
    }
  }

  assert.deepEqual(forbiddenFiles, [], `Forbidden files found in zip handoff: ${forbiddenFiles.join(", ")}`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
