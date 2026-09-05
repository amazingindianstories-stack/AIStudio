import assert from "node:assert/strict";
import { test } from "vitest";
import {
  assertCompatibleCheckpoint,
  collectMediaKeys,
  newCheckpoint,
  scanBucketPages,
  verificationResult,
} from "./gcs-media-verifier";

test("collectMediaKeys finds nested app media paths and ignores external URLs", () => {
  const keys = collectMediaKeys({
    image: "/api/media/assets%2Fone.webp",
    nested: ["https://example.com/nope", { video: "/api/media/videos/two.mp4" }],
  });
  assert.deepEqual([...keys].sort(), ["assets/one.webp", "videos/two.mp4"]);
});

test("scanBucketPages finds referenced keys across pages", async () => {
  const referencedKeys = ["a", "c", "missing"];
  const checkpoint = newCheckpoint("bucket", referencedKeys);
  const pages = new Map([
    [undefined, { keys: ["a", "b"], nextPageToken: "page-2" }],
    ["page-2", { keys: ["c", "d"], nextPageToken: null }],
  ]);
  const saved = [];
  const scan = await scanBucketPages({
    referencedKeys,
    checkpoint,
    maxPages: 10,
    listPage: async (token) => pages.get(token),
    saveCheckpoint: async (state) => saved.push(structuredClone(state)),
  });
  const result = verificationResult(referencedKeys, scan.checkpoint, scan.complete);

  assert.equal(scan.complete, true);
  assert.equal(saved.length, 2);
  assert.deepEqual(result.missingKeys, ["missing"]);
  assert.equal(result.storedObjects, 4);
  assert.equal(result.pagesScanned, 2);
});

test("a page budget returns a resumable checkpoint", async () => {
  const referencedKeys = ["a", "c"];
  const initial = newCheckpoint("bucket", referencedKeys);
  const first = await scanBucketPages({
    referencedKeys,
    checkpoint: initial,
    maxPages: 1,
    listPage: async () => ({ keys: ["a"], nextPageToken: "page-2" }),
  });
  assert.equal(first.complete, false);
  assert.equal(first.checkpoint.nextPageToken, "page-2");
  assert.deepEqual(first.checkpoint.foundKeys, ["a"]);
  assert.deepEqual(first.checkpoint.referencedKeys, ["a", "c"]);

  const second = await scanBucketPages({
    referencedKeys,
    checkpoint: first.checkpoint,
    maxPages: 1,
    listPage: async (token) => {
      assert.equal(token, "page-2");
      return { keys: ["c"], nextPageToken: null };
    },
  });
  assert.equal(second.complete, true);
  assert.equal(verificationResult(referencedKeys, second.checkpoint, true).missing, 0);
});

test("a checkpoint cannot resume against a changed reference set", () => {
  const checkpoint = newCheckpoint("bucket", ["a"]);
  assert.throws(
    () => assertCompatibleCheckpoint(checkpoint, "bucket", ["a", "b"]),
    /--reset/
  );
  assert.throws(
    () => assertCompatibleCheckpoint(checkpoint, "different-bucket", ["a"]),
    /--reset/
  );
});
