import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { boundedBestOf, generateAndSpoolCandidates, readSpooledBase64 } from "./best-of-spool";

test("boundedBestOf caps candidate count by actual render size", () => {
  assert.equal(boundedBestOf(4, "1K"), 4);
  assert.equal(boundedBestOf(4, "2K"), 3);
  assert.equal(boundedBestOf(4, "4K"), 2);
});

test("candidate generation is serial and preserves partial successes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "best-of-test-"));
  let active = 0;
  let peak = 0;
  try {
    const { candidates, errors } = await generateAndSpoolCandidates({
      count: 3,
      directory,
      generate: async (i) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        if (i === 1) throw new Error("candidate failed");
        return { base64: Buffer.from(`candidate-${i}`).toString("base64"), mimeType: "image/png" };
      },
    });
    assert.equal(peak, 1);
    assert.equal(candidates.length, 2);
    assert.equal(errors.length, 1);
    assert.equal(Buffer.from(await readSpooledBase64(candidates[1]), "base64").toString(), "candidate-2");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
