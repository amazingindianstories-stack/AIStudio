/**
 * Guard: archives written by `zip.js` must be readable by Python's stdlib
 * `zipfile`, byte-for-byte in content.
 *
 * WHY THIS EXISTS
 * `/api/history/download-zip` uses the hand-rolled writer in `zip.js`. It
 * emits its own local headers, central
 * directory and end-of-central-directory record, and a subtly malformed
 * field is the kind of thing every tool tolerates until one does not.
 *
 * Python's `zipfile` is a strict, independent reader. If it can open our
 * archive and read every entry back unchanged, the format is sound.
 *
 * Skips cleanly when python3 is unavailable, so this never becomes the
 * reason a developer's suite fails on a machine without it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createZipArchive } from "@/lib/zip";

const python = ["python3", "python"].find(
  (bin) => spawnSync(bin, ["-c", "import zipfile"], { encoding: "utf8" }).status === 0
);

test("zip.js archives open cleanly in Python's zipfile", { skip: !python }, () => {
  // Deliberately awkward inputs: binary bytes that include the 0x50 0x4b
  // signature bytes a naive scanner might mistake for a header, an empty
  // entry, and a long name — the cases a hand-rolled writer gets wrong.
  // Filenames stay in the shape download-zip actually produces.
  //
  // The non-ASCII entry is here to pin `sanitizeName`'s behaviour rather than
  // to test encoding: the writer deliberately replaces anything outside
  // [A-Za-z0-9._/-] with "_", which sidesteps the whole CP437-vs-UTF-8
  // filename question by never emitting a non-ASCII name in the first place.
  // That is a defensible design and it should not change silently, so the
  // expected name below is the sanitised one.
  const entries = [
    { name: "01-plain.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    { name: "02-has-pk-bytes.bin", data: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x50, 0x4b, 0x01, 0x02]) },
    { name: "03-empty.bin", data: Buffer.alloc(0) },
    { name: "04-" + "x".repeat(120) + ".jpg", data: Buffer.from("a".repeat(5000), "utf8") },
    { name: "05-café-ünïcode.webp", data: Buffer.from("café", "utf8"), storedAs: "05-caf_-_n_code.webp" },
  ];
  const storedName = (e) => e.storedAs ?? e.name;

  const dir = mkdtempSync(join(tmpdir(), "zip-parity-"));
  const archivePath = join(dir, "out.zip");
  writeFileSync(archivePath, Buffer.from(createZipArchive(entries)));

  const script = `
import json, sys, zipfile
path = sys.argv[1]
with zipfile.ZipFile(path) as z:
    bad = z.testzip()
    if bad is not None:
        print(json.dumps({"error": "corrupt entry: " + bad})); sys.exit(0)
    out = {name: z.read(name).hex() for name in z.namelist()}
    print(json.dumps({"entries": out, "order": z.namelist()}))
`;
  const res = spawnSync(python, ["-c", script, archivePath], { encoding: "utf8" });
  assert.equal(
    res.status,
    0,
    `python could not read the archive at all:\n${res.stderr || res.stdout}\n\n` +
      `That means zip.js is emitting something a strict reader rejects.`
  );

  const parsed = JSON.parse(res.stdout);
  assert.ok(!parsed.error, `python reported a corrupt archive: ${parsed.error}`);

  assert.deepEqual(
    parsed.order,
    entries.map(storedName),
    "entry names/order changed passing through the archive"
  );

  for (const entry of entries) {
    assert.equal(
      parsed.entries[storedName(entry)],
      Buffer.from(entry.data).toString("hex"),
      `contents of "${storedName(entry)}" did not survive the round trip`
    );
  }
});
