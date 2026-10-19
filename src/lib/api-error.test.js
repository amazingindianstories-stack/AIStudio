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
    assert.equal(apiErrorMessage(body, 503), "The server had a problem. Try again in a moment.");
  }
  assert.equal(apiErrorMessage({}, 418), "Request failed (418).");
});

test("machine codes are translated and never shown raw", () => {
  assert.equal(apiErrorMessage({ error: "UNAUTHENTICATED" }, 401), "Your session has ended. Sign in again.");
  assert.equal(apiErrorMessage({ error: "Folder name taken", code: "DUPLICATE_FOLDER_NAME" }, 409), "A folder with that name already exists here.");
  assert.equal(apiErrorMessage({ error: "SOME_NEW_CODE" }, 400, "Could not save."), "Could not save.");
  assert.equal(apiErrorMessage({ error: "SOME_NEW_CODE" }, 429), "Too many requests. Wait a moment and try again.");
  assert.equal(apiErrorMessage({ error: "PREVIEW_PORTRAIT_GROUP_DELETE_REQUIRES_ARCHIVE" }, 409), "Characters can't be deleted yet. Delete the portraits inside it instead.");
  assert.equal(apiErrorMessage({ error: "This operation is not available.", code: "PREVIEW_OPERATION_DISABLED" }, 403), "This is turned off on this deployment.");
});

test("caller fallback applies when the body has no message", () => {
  assert.equal(apiErrorMessage(null, 400, "Could not create the user."), "Could not create the user.");
  assert.equal(apiErrorMessage({ error: "Email already in use." }, 400, "Could not create the user."), "Email already in use.");
});

test("long messages are bounded", () => {
  const text = apiErrorMessage({ error: "x".repeat(1000) }, 400);
  assert.equal(text.length, 280);
  assert.ok(text.endsWith("…"));
});
