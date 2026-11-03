import { test } from "node:test";
import assert from "node:assert/strict";
import { isLimitValueAllowed, LIMIT_DEFINITIONS, limitDefinition, parseLimitValue, USER_LIMIT_DEFINITIONS } from "./limits";

test("limitDefinition: finds a registered key, undefined for an unknown one", () => {
  assert.equal(limitDefinition("maxPromptLength")?.key, "maxPromptLength");
  assert.equal(limitDefinition("not-a-real-limit"), undefined);
});

test("admin limit validation rejects concurrency values above the hard maximum", () => {
  const def = limitDefinition("maxConcurrentJobs");
  assert.equal(isLimitValueAllowed(1, def), true);
  assert.equal(isLimitValueAllowed(8, def), true);
  assert.equal(isLimitValueAllowed(9, def), false);
  assert.equal(isLimitValueAllowed(Number.NaN, def), false);
});

test("LIMIT_DEFINITIONS: every entry has a positive default at or above its own minimum", () => {
  // A definition whose own default violates its own min would make every
  // fresh install (or a corrupted-row fallback) start out invalid.
  for (const def of LIMIT_DEFINITIONS) {
    assert.ok(def.defaultValue >= def.min, `${def.key}: default below min`);
    // A feature switch is 1 (on) or 0 (off); every other limit must stay at least 1.
    assert.ok(def.min >= (def.switch ? 0 : 1), `${def.key}: min must be at least 1`);
  }
});

test("maxConcurrentJobs defaults to eight aggregate image/video slots and has a hard maximum", () => {
  const def = limitDefinition("maxConcurrentJobs");
  assert.equal(def.defaultValue, 8);
  assert.equal(def.min, 1);
  assert.equal(def.max, 8);
  assert.equal(parseLimitValue("99", def), 8);
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

test("seedanceConcurrency is a global-only limit: default 3 per model, at most 50, never per user", () => {
  const def = limitDefinition("seedanceConcurrency");
  assert.equal(def.defaultValue, 3);
  assert.equal(def.max, 50);
  assert.equal(def.globalOnly, true);
  assert.ok(!USER_LIMIT_DEFINITIONS.some((d) => d.key === "seedanceConcurrency"));
  assert.ok(USER_LIMIT_DEFINITIONS.some((d) => d.key === "maxConcurrentJobs"));
});

test("a feature switch is 0 or 1, defaults on, and a corrupted value falls back to on", () => {
  const def = limitDefinition("boardAiEnabled");
  assert.equal(def.switch, true);
  assert.equal(parseLimitValue("0", def), 0);
  assert.equal(parseLimitValue("1", def), 1);
  assert.equal(parseLimitValue("5", def), 1);
  assert.equal(parseLimitValue("junk", def), 1);
  assert.equal(isLimitValueAllowed(2, def), false);
});

test("agent limits: registered with the planned defaults and bounds", () => {
  const expected = {
    agentsEnabled: [0, 0, 1], agentActiveRuns: [2, 1, 8], agentMaxStepsPerRun: [40, 1, 200], agentMaxRunCostCents: [1000, 1, 100000],
    agentGlobalDailyCapCents: [20000, 1, 10000000], agentMaxConcurrentRuns: [8, 1, 50], agentAttachMaxMb: [20, 1, 100],
    agentAttachMaxVideoSeconds: [300, 1, 3600], agentAttachMaxAudioSeconds: [600, 1, 7200], agentAttachImages: [1, 0, 1],
    agentAttachDocuments: [1, 0, 1], agentAttachVideo: [1, 0, 1], agentAttachAudio: [1, 0, 1],
  };
  for (const [key, [defaultValue, min, max]] of Object.entries(expected)) {
    const def = limitDefinition(key);
    assert.deepEqual([def.defaultValue, def.min, def.max], [defaultValue, min, max], key);
    assert.equal(def.switch === true, max === 1, `${key}: switch flag`);
  }
});

test("agent limits: global-only keys are absent from the per-user panel, the rest are present", () => {
  const perUser = USER_LIMIT_DEFINITIONS.map((d) => d.key);
  for (const key of ["agentGlobalDailyCapCents", "agentMaxConcurrentRuns"]) {
    assert.equal(limitDefinition(key).globalOnly, true);
    assert.ok(!perUser.includes(key), key);
  }
  for (const key of ["agentsEnabled", "agentActiveRuns", "agentAttachAudio", "agentAttachMaxMb"]) assert.ok(perUser.includes(key), key);
});

test("agentsEnabled: the kill switch is explained, and 0 is a valid stored value", () => {
  const def = limitDefinition("agentsEnabled");
  assert.match(def.description, /kill switch/);
  assert.ok(def.note);
  assert.equal(isLimitValueAllowed(0, def), true);
  assert.equal(isLimitValueAllowed(2, def), false);
  assert.equal(parseLimitValue("0", def), 0);
});

test("mcpDailyCapCents is relabelled Agent daily cap and says it covers the Agents tab and model cost", () => {
  const def = limitDefinition("mcpDailyCapCents");
  assert.equal(def.label, "Agent daily cap");
  assert.match(def.description, /Agents tab/);
  assert.match(def.description, /token cost/);
});
