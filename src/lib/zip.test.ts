import test from "node:test";
import assert from "node:assert/strict";
import { createZipArchive } from "./zip";

function hasAscii(haystack: Uint8Array, needle: string): boolean {
  const text = new TextDecoder().decode(haystack);
  return text.includes(needle);
}

test("createZipArchive: emits a zip with both filenames and payload markers", () => {
  const zip = createZipArchive([
    { name: "one.png", data: new Uint8Array([1, 2, 3]) },
    { name: "two.jpg", data: new Uint8Array([4, 5, 6, 7]) },
  ]);

  assert.equal(hasAscii(zip, "one.png"), true);
  assert.equal(hasAscii(zip, "two.jpg"), true);
  assert.equal(zip[zip.length - 22], 0x50);
  assert.equal(zip[zip.length - 21], 0x4b);
  assert.equal(zip[zip.length - 20], 0x05);
  assert.equal(zip[zip.length - 19], 0x06);
});
