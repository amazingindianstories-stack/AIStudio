import assert from "node:assert/strict";
import { test } from "vitest";
import { MEDIA_ACTION_COPY, mediaActionCopy } from "./media-action-confirmation.js";

test("every risky media shortcut has explicit confirmation copy", () => {
  assert.deepEqual(Object.keys(MEDIA_ACTION_COPY).sort(), [
    "cloneToComposer",
    "continueShot",
    "deleteAsset",
    "deleteGeneration",
    "editPrompt",
    "regenerate",
    "regenerateWithSameSeed",
    "retryTextToVideo",
  ]);
  for (const copy of Object.values(MEDIA_ACTION_COPY)) {
    assert.ok(copy.title);
    assert.ok(copy.description);
    assert.ok(copy.confirmLabel);
  }
});

test("only permanent deletion confirmations use destructive styling", () => {
  assert.equal(mediaActionCopy("deleteGeneration").destructive, true);
  assert.equal(mediaActionCopy("deleteAsset").destructive, true);
  assert.equal(mediaActionCopy("retryTextToVideo").destructive, undefined);
});

test("unknown media action kinds fail loudly", () => {
  assert.throws(() => mediaActionCopy("unknown"), /Unknown confirmed media action/);
});
