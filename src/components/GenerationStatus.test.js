import test from "node:test";
import assert from "node:assert/strict";
import { waitingNote } from "./GenerationStatus.jsx";

test("waitingNote explains a queued video that waits for a portrait or a provider slot", () => {
  const slot = { kind: "video", providerStatus: "SLOT_WAITING", progressMessage: "Waiting for a free Seedance 2.5 slot - it starts automatically." };
  assert.equal(waitingNote(slot), slot.progressMessage);
  assert.equal(waitingNote({ ...slot, providerStatus: "PORTRAIT_WAITING", progressMessage: "Preparing portraits…" }), "Preparing portraits…");
  assert.equal(waitingNote({ ...slot, providerStatus: "running" }), null, "other provider states are not waits");
  assert.equal(waitingNote({ ...slot, kind: "image" }), null);
  assert.equal(waitingNote({ ...slot, pollWarning: "Still checking" }), null, "a poll warning takes the caption");
  assert.equal(waitingNote(null), null);
});

test("waitingNote shows the worker slot reason for images and videos", () => {
  for (const kind of ["image", "video"]) {
    const item = { kind, providerStatus: "WORKER_SLOT_WAITING", progressMessage: "Waiting for a free worker slot" };
    assert.equal(waitingNote(item), item.progressMessage);
    assert.equal(waitingNote({ ...item, pollWarning: "Still checking" }), null);
  }
});
