import assert from "node:assert/strict";
import test from "node:test";
import { completedImageStatus } from "./ProgressiveImage.jsx";

test("already-cached images settle as loaded even when no load event is observed", () => {
  assert.equal(completedImageStatus({ complete: true, naturalWidth: 512 }), "loaded");
});

test("completed broken images settle as errors", () => {
  assert.equal(completedImageStatus({ complete: true, naturalWidth: 0 }), "error");
});

test("in-flight images remain loading until an event or completion", () => {
  assert.equal(completedImageStatus({ complete: false, naturalWidth: 0 }), null);
  assert.equal(completedImageStatus(null), null);
});
