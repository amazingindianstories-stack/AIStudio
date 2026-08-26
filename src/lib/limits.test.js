import { test } from "node:test";
import assert from "node:assert/strict";
import { LIMIT_DEFINITIONS, limitDefinition, parseLimitValue } from "./limits";

test("limitDefinition: finds a registered key, undefined for an unknown one", () => {
  assert.equal(limitDefinition("maxPromptLength")?.key, "maxPromptLength");
  assert.equal(limitDefinition("not-a-real-limit"), undefined);
});

test("LIMIT_DEFINITIONS: every entry has a positive default at or above its own minimum", () => {
  // A definition whose own default violates its own min would make every
  // fresh install (or a corrupted-row fallback) start out invalid.
  for (const def of LIMIT_DEFINITIONS) {
    assert.ok(def.defaultValue >= def.min, `${def.key}: default below min`);
    assert.ok(def.min >= 1, `${def.key}: min must be at least 1`);
  }
});

test("maxConcurrentJobs defaults to one shared slot per user and kind", () => {
  const def = limitDefinition("maxConcurrentJobs");
  assert.equal(def.defaultValue, 1);
  assert.equal(def.min, 1);
});

const maxPromptLength = limitDefinition("maxPromptLength");

test("parseLimitValue: valid values at or above the minimum pass through", () => {
  assert.equal(parseLimitValue("50", maxPromptLength), 50);
  assert.equal(parseLimitValue("30000", maxPromptLength), 30000);
  assert.equal(parseLimitValue(String(maxPromptLength.min), maxPromptLength), maxPromptLength.min);
});

test("parseLimitValue: missing/unset value falls back to the definition's default", () => {
  assert.equal(parseLimitValue(undefined, maxPromptLength), maxPromptLength.defaultValue);
  assert.equal(parseLimitValue(null, maxPromptLength), maxPromptLength.defaultValue);
});

test("parseLimitValue: garbage, zero, or below-minimum values fall back to the default", () => {
  // A corrupted row must never leave the limit at 0 (blocks everything) or
  // negative (meaningless) — same reasoning for any definition, not just
  // this one, since every definition here has min >= 1.
  assert.equal(parseLimitValue("not-a-number", maxPromptLength), maxPromptLength.defaultValue);
  assert.equal(parseLimitValue("0", maxPromptLength), maxPromptLength.defaultValue);
  assert.equal(parseLimitValue("-5", maxPromptLength), maxPromptLength.defaultValue);
});

test("parseLimitValue: parses the leading integer out of a loosely-formatted value", () => {
  assert.equal(parseLimitValue("30000.5", maxPromptLength), 30000);
  assert.equal(parseLimitValue("  40000  ", maxPromptLength), 40000);
});
