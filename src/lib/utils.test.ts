/**
 * Unit tests for src/lib/utils.ts — currently just `resolveThumb`, the
 * precomputed-thumbnail-vs-on-the-fly-resize precedence helper.
 *
 * Derived from the "Interfaces" section of
 * .council/thumbnail-pipeline/design.md against the documented contract
 * (`resolveThumb` delegates to the pre-existing, already-shipped `thumbUrl`
 * for its fallback path — that part is existing behavior read from
 * src/lib/utils.ts, not guessed). Run:
 *   npx tsx --test src/lib/utils.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveThumb, thumbUrl } from "./utils";

test("thumbnailUrl present is returned as-is, not re-wrapped with a ?w= param", () => {
  const thumbnailUrl = "/api/media/thumbnails/abc123.webp";
  const result = resolveThumb(thumbnailUrl, "/api/media/originals/abc123.png", 480);
  assert.equal(result, thumbnailUrl);
  assert.ok(!result!.includes("?w="), "a precomputed thumbnail must never be double-wrapped");
});

test("thumbnailUrl present takes precedence over fallbackUrl even when both are set", () => {
  const thumbnailUrl = "/api/media/thumbnails/xyz.webp";
  const fallbackUrl = "/api/media/originals/xyz.png";
  const result = resolveThumb(thumbnailUrl, fallbackUrl, 1200);
  assert.equal(result, thumbnailUrl);
});

test("thumbnailUrl absent falls back to thumbUrl(fallbackUrl, width) for a /api/media/ URL", () => {
  const fallbackUrl = "/api/media/originals/abc123.png";
  const result = resolveThumb(undefined, fallbackUrl, 480);
  assert.equal(result, thumbUrl(fallbackUrl, 480));
  assert.equal(result, `${fallbackUrl}?w=480`);
});

test("thumbnailUrl absent, fallback /api/media/ URL already has a query string -> appends with &w=", () => {
  const fallbackUrl = "/api/media/originals/abc123.png?foo=bar";
  const result = resolveThumb(undefined, fallbackUrl, 320);
  assert.equal(result, `${fallbackUrl}&w=320`);
});

test("both thumbnailUrl and fallbackUrl absent -> returns undefined", () => {
  assert.equal(resolveThumb(undefined, undefined, 480), undefined);
});

test("thumbnailUrl absent, fallback is a data: URL -> passed through unchanged (thumbUrl pass-through rule)", () => {
  const dataUrl = "data:image/png;base64,AAAA";
  const result = resolveThumb(undefined, dataUrl, 480);
  assert.equal(result, dataUrl);
});

test("thumbnailUrl absent, fallback is an external https:// URL -> passed through unchanged", () => {
  const externalUrl = "https://cdn.example.com/some-image.png";
  const result = resolveThumb(undefined, externalUrl, 480);
  assert.equal(result, externalUrl);
});

test("thumbnailUrl as an empty string is falsy and falls through to the fallback path", () => {
  const fallbackUrl = "/api/media/originals/abc123.png";
  const result = resolveThumb("", fallbackUrl, 480);
  assert.equal(result, `${fallbackUrl}?w=480`);
});

test("thumbnailUrl present with fallbackUrl undefined still returns thumbnailUrl without touching the fallback path", () => {
  const thumbnailUrl = "/api/media/thumbnails/solo.webp";
  const result = resolveThumb(thumbnailUrl, undefined, 480);
  assert.equal(result, thumbnailUrl);
});
