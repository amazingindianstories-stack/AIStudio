import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { writeZip64 } from "./zip64-stream";

test("Zip64 writer preserves 250+ stored entries, order, CRCs, and contents", async () => {
  const chunks = [];
  const entries = Array.from({ length: 257 }, (_, index) => {
    const data = Buffer.from(`payload-${index}-${"x".repeat(index % 19)}`);
    return { name: `${String(index).padStart(4, "0")}.png`, size: data.length, stream: (async function* () { yield data.slice(0, 3); yield data.slice(3); })() };
  });
  const result = await writeZip64(entries, async (chunk) => chunks.push(Buffer.from(chunk)), { now: new Date("2026-01-02T03:04:06Z") });
  assert.equal(result.entries, 257);
  const directory = mkdtempSync(join(tmpdir(), "zip64-")); const archive = join(directory, "archive.zip"); writeFileSync(archive, Buffer.concat(chunks));
  const script = `import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z:\n assert z.testzip() is None\n print(json.dumps([[i.filename,z.read(i).decode()] for i in z.infolist()]))`;
  const checked = spawnSync("python3", ["-c", script, archive], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
  const rows = JSON.parse(checked.stdout); assert.equal(rows.length, 257); assert.equal(rows[0][0], "0000.png"); assert.equal(rows[256][0], "0256.png"); assert.equal(rows[149][1], `payload-149-${"x".repeat(149 % 19)}`);
});
