import assert from "node:assert/strict";
import test from "node:test";
import { apiErrorMessage } from "./api-error.js";

test("generation errors preserve provider and gateway messages", () => {
  assert.equal(apiErrorMessage({ error: "Reference video is too small" }, 400), "Reference video is too small");
  assert.equal(apiErrorMessage({ error: { code: "INVALID_REFERENCE", message: "Reference video is too small" } }, 400), "Reference video is too small");
  assert.equal(apiErrorMessage({ error: { error: { message: "Generation temporarily paused" } } }, 403), "Generation temporarily paused");
});

test("unrecognized errors use HTTP status without exposing response fields", () => {
  for (const body of [null, {}, { error: { code: "FAILED", token: "private" } }, { error: [] }]) {
    assert.equal(apiErrorMessage(body, 503), "Server error: 503");
  }
});
