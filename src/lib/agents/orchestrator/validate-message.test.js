import { test } from "vitest";
import assert from "node:assert/strict";
import { parseMessageBody, MAX_CONTENT_LEN, MAX_IMAGES } from "./validate-message";

test("accepts a well-formed body with no images", () => {
  assert.deepEqual(parseMessageBody({ content: "hello" }), { content: "hello", images: [] });
});

test("trims content", () => {
  assert.deepEqual(parseMessageBody({ content: "  hello  " }), { content: "hello", images: [] });
});

test("rejects a missing/blank content field", () => {
  assert.deepEqual(parseMessageBody({}), { error: "content is required." });
  assert.deepEqual(parseMessageBody({ content: "   " }), { error: "content is required." });
  assert.deepEqual(parseMessageBody(null), { error: "content is required." });
});

test("rejects content over the length cap", () => {
  const result = parseMessageBody({ content: "a".repeat(MAX_CONTENT_LEN + 1) });
  assert.ok("error" in result);
});

test("accepts a well-formed images array and drops non-string entries", () => {
  const result = parseMessageBody({ content: "hi", images: ["data:...", 5, null, "data:..2"] });
  assert.deepEqual(result, { content: "hi", images: ["data:...", "data:..2"] });
});

test("rejects a non-array images field", () => {
  assert.deepEqual(parseMessageBody({ content: "hi", images: "not-an-array" }), {
    error: "images must be an array of data URLs.",
  });
});

test("rejects more than MAX_IMAGES attachments", () => {
  const images = Array.from({ length: MAX_IMAGES + 1 }, () => "data:...");
  const result = parseMessageBody({ content: "hi", images });
  assert.ok("error" in result);
});
