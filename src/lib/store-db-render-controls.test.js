import assert from "node:assert/strict";
import test from "node:test";
import { itemToValues, rowToItem } from "./store-db";

const base = { id: "00000000-0000-0000-0000-000000000001", kind: "video", status: "queued", prompt: "scene", model: "Seedance 2.0", aspectRatio: "16:9", createdAt: 1, updatedAt: 1 };

test("render controls round-trip through generation row serialization", () => {
  const values = itemToValues({ ...base, draftMode: true, bitrateMode: "standard" });
  const item = rowToItem({ ...values, isFavorite: false, flagged: false, depthReapAttempts: 0 });
  assert.equal(item.draftMode, true);
  assert.equal(item.bitrateMode, "standard");
});

test("legacy null rows omit render controls from serialized items", () => {
  const item = rowToItem({ ...itemToValues(base), draftMode: null, bitrateMode: null, isFavorite: false, flagged: false, depthReapAttempts: 0 });
  assert.equal(item.draftMode, undefined);
  assert.equal(item.bitrateMode, undefined);
});
