import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeSlug, isReservedSlug } from "./assets-db.js";
import { ASSET_KINDS } from "./types.js";

test("sanitizeSlug cleans names into valid @mentions slugs", () => {
  assert.equal(sanitizeSlug("Sati"), "sati");
  assert.equal(sanitizeSlug("Scene 1"), "scene-1");
  assert.equal(sanitizeSlug("Magic Sword #9"), "magic-sword-9");
  assert.equal(sanitizeSlug("Dr. Watson (Old)"), "dr-watson-old");
  assert.equal(sanitizeSlug("  --Priya--  "), "priya");
  assert.equal(sanitizeSlug(""), "asset");
  assert.equal(sanitizeSlug("   "), "asset");
  assert.equal(sanitizeSlug("###"), "asset");
});

test("isReservedSlug catches all ad-hoc system tags", () => {
  assert.equal(isReservedSlug("img1"), true);
  assert.equal(isReservedSlug("IMG42"), true);
  assert.equal(isReservedSlug("vid1"), true);
  assert.equal(isReservedSlug("VID9"), true);
  assert.equal(isReservedSlug("video1"), true);
  assert.equal(isReservedSlug("VIDEO5"), true);
  assert.equal(isReservedSlug("audio1"), true);
  assert.equal(isReservedSlug("AUDIO10"), true);

  // Non-reserved names
  assert.equal(isReservedSlug("sati"), false);
  assert.equal(isReservedSlug("scene1"), false);
  assert.equal(isReservedSlug("image"), false);
  assert.equal(isReservedSlug("video"), false);
  assert.equal(isReservedSlug("audio"), false);
});

test("sanitizeSlug prevents collisions with reserved ad-hoc tags", () => {
  assert.equal(sanitizeSlug("img1"), "asset-img1");
  assert.equal(sanitizeSlug("vid2"), "asset-vid2");
  assert.equal(sanitizeSlug("audio1"), "asset-audio1");
});

test("ASSET_KINDS contains required material kinds", () => {
  assert.ok(ASSET_KINDS.includes("character"));
  assert.ok(ASSET_KINDS.includes("prop"));
  assert.ok(ASSET_KINDS.includes("location"));
  assert.ok(ASSET_KINDS.includes("style"));
  assert.ok(ASSET_KINDS.includes("audio"));
  assert.ok(ASSET_KINDS.includes("other"));
});
