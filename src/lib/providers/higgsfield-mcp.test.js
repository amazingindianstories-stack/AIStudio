/**
 * Tests for the pure, network-free parts of providers/higgsfield-mcp.js.
 *
 * This file's own OAuth/JSON-RPC/SSE session machinery (ensureSession,
 * callTool, the token file) has no test coverage here by design — CLAUDE.md
 * flags this module as the highest-risk port in the codebase (structurally
 * ported, never opened against a real MCP session) and lower-priority to
 * re-verify than the other providers, since Higgsfield is already out of the
 * UI (2026-07-30). Building a mock harness for that machinery is a separate,
 * much larger effort than pinning this change.
 *
 * What IS covered: buildRefRoles, the Phase 1.3 wiring helper that turns a
 * raw @imgN-tagged prompt into the Map<number, role> buildVideoDirective
 * consumes for its per-reference legend (video-directive.test.js pins
 * buildVideoDirective's own behavior once handed such a map — this file pins
 * that the map gets built correctly in the first place). Pure, synchronous,
 * no network/file access.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildRefRoles } from "./higgsfield-mcp";

test("buildRefRoles: mixed person + style tags map to their 1-based indices", () => {
  const prompt =
    "THIS EXACT FACE and identity from @img1. She dances under neon light. " +
    "Match the exact mood and color grade from @img2.";
  const roles = buildRefRoles(prompt, 2);
  assert.equal(roles.get(1), "person");
  assert.equal(roles.get(2), "style");
  assert.equal(roles.size, 2);
});

test("buildRefRoles: no @imgN tags in the prompt returns undefined, not an empty Map", () => {
  assert.equal(buildRefRoles("she dances under neon light", 2), undefined);
});

test("buildRefRoles: no media attached returns undefined even if the prompt has tags", () => {
  assert.equal(buildRefRoles("the face from @img1", 0), undefined);
});

test("buildRefRoles: a tag beyond mediaCount is dropped — Higgsfield always attaches every referenceImages entry in order, so an out-of-range tag can't correspond to any attached image", () => {
  const roles = buildRefRoles("the face from @img1, styled like @img9", 2);
  assert.equal(roles.get(1), "person");
  assert.equal(roles.has(9), false);
  assert.equal(roles.size, 1);
});

test("buildRefRoles: a named @slug asset tag is ignored — it isn't positionally mapped to mediaIds here", () => {
  const roles = buildRefRoles("the exact style from @priya and the face from @img1", 2);
  assert.equal(roles.get(1), "person");
  assert.equal(roles.size, 1);
});

test("buildRefRoles: an untagged single reference (the common case) returns undefined", () => {
  assert.equal(buildRefRoles("she turns to face the camera", 1), undefined);
});
