import assert from "node:assert/strict";
import { test } from "vitest";
import { extensionFromBytes } from "./media-sniff";

test("extensionFromBytes: recognises a PNG signature", () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  assert.equal(extensionFromBytes(bytes, "https://x/abc123"), "png");
});

test("extensionFromBytes: recognises a JPEG signature", () => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
  assert.equal(extensionFromBytes(bytes, "https://x/abc123"), "jpg");
});

test("extensionFromBytes: recognises a WebP signature (RIFF....WEBP)", () => {
  const bytes = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
  ]);
  assert.equal(extensionFromBytes(bytes, "https://x/abc123"), "webp");
});

test("extensionFromBytes: a RIFF file that isn't WEBP (e.g. WAV) is not misdetected", () => {
  const bytes = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, // "WAVE"
  ]);
  assert.notEqual(extensionFromBytes(bytes, "https://x/abc123"), "webp");
});

test("extensionFromBytes: recognises a GIF signature", () => {
  const bytes = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]);
  assert.equal(extensionFromBytes(bytes, "https://x/abc123"), "gif");
});

test("extensionFromBytes: recognises an AVIF ISOBMFF brand", () => {
  const bytes = Buffer.from([
    0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0, 0,
  ]);
  assert.equal(extensionFromBytes(bytes, "https://x/abc123"), "avif");
});

test("extensionFromBytes: the exact bug case — an extensionless UUID key with unrecognised bytes falls back to .bin, not the URL's dot-suffix", () => {
  const bytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(
    extensionFromBytes(bytes, "https://x/media/9f2c-uuid-with-no-extension"),
    "bin"
  );
});

test("extensionFromBytes: unrecognised bytes still fall back to a real URL extension when present", () => {
  const bytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(extensionFromBytes(bytes, "https://x/media/thing.png?token=abc"), "png");
});

test("extensionFromBytes: a too-short buffer (fewer bytes than any signature needs) never throws", () => {
  assert.equal(extensionFromBytes(Buffer.from([]), "https://x/abc"), "bin");
  assert.equal(extensionFromBytes(Buffer.from([0x89]), "https://x/abc"), "bin");
});
