import test from "node:test";
import assert from "node:assert/strict";
import { resolveGcsReadFile } from "./gcs-read-fallback.js";

test("legacy media fallback is read-only and only selected for a primary miss", async () => {
  const calls = [];
  const primary = { exists: async () => [false] };
  const legacy = {};
  const options = { primaryBucket: "preview", fallbackBucket: "historical",
    fileFor: (bucket, key) => { calls.push([bucket, key]); return bucket === "preview" ? primary : legacy; } };
  assert.equal(await resolveGcsReadFile("generations/old.mp4", options), legacy);
  assert.deepEqual(calls, [["preview", "generations/old.mp4"], ["historical", "generations/old.mp4"]]);
  primary.exists = async () => [true];
  calls.length = 0;
  assert.equal(await resolveGcsReadFile("generations/new.mp4", options), primary);
  assert.equal(calls.length, 1);
});

test("legacy reads never mask authorization or network errors", async () => {
  for (const code of [403, 429, 500]) {
    const error = Object.assign(new Error("storage unavailable"), { code });
    let lookups = 0;
    await assert.rejects(resolveGcsReadFile("generations/a.mp4", {
      primaryBucket: "preview", fallbackBucket: "historical",
      fileFor: () => { lookups++; return { exists: async () => { throw error; } }; },
    }), error);
    assert.equal(lookups, 1);
  }
});

test("no extra lookup without fallback, for the same bucket, or for protected namespaces", async () => {
  const primary = { exists: async () => { throw Error("must not probe"); } };
  for (const fallbackBucket of [undefined, "preview", "historical"]) {
    assert.equal(await resolveGcsReadFile("settings/private.json", {
      primaryBucket: "preview", fallbackBucket,
      fileFor: () => primary, isProtected: () => true,
    }), primary);
  }
});
