import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MAX_PROMPT_LENGTH, parseMaxPromptLength } from "./settings";

test("parseMaxPromptLength: valid positive integers pass through", () => {
  assert.equal(parseMaxPromptLength("50"), 50);
  assert.equal(parseMaxPromptLength("30000"), 30000);
  assert.equal(parseMaxPromptLength("1"), 1);
});

test("parseMaxPromptLength: missing/unset value falls back to the default", () => {
  assert.equal(parseMaxPromptLength(undefined), DEFAULT_MAX_PROMPT_LENGTH);
  assert.equal(parseMaxPromptLength(null), DEFAULT_MAX_PROMPT_LENGTH);
  assert.equal(parseMaxPromptLength(""), DEFAULT_MAX_PROMPT_LENGTH);
});

test("parseMaxPromptLength: garbage, zero, or negative values fall back to the default", () => {
  // A corrupted row must never leave every prompt looking "too long" (0) or
  // let the limit vanish entirely (negative parsing to a usable number).
  assert.equal(parseMaxPromptLength("not-a-number"), DEFAULT_MAX_PROMPT_LENGTH);
  assert.equal(parseMaxPromptLength("0"), DEFAULT_MAX_PROMPT_LENGTH);
  assert.equal(parseMaxPromptLength("-5"), DEFAULT_MAX_PROMPT_LENGTH);
});

test("parseMaxPromptLength: parses the leading integer out of a loosely-formatted value", () => {
  // parseInt's normal behavior — documented via a test rather than assumed,
  // since this is what actually runs against whatever ends up stored.
  assert.equal(parseMaxPromptLength("30000.5"), 30000);
  assert.equal(parseMaxPromptLength("  40000  "), 40000);
});
