/**
 * Unit tests for src/lib/thumbnail.ts — the pure, storage-agnostic
 * thumbnail+blur generator (`generateThumbnailAndBlur`).
 *
 * Derived from the "Interfaces" and "Test contract" sections of
 * .council/thumbnail-pipeline/design.md against the documented contract,
 * not the implementation (written before reading src/lib/thumbnail.ts).
 * Run:
 *   npx tsx --test src/lib/thumbnail.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  generateThumbnailAndBlur,
  THUMB_MAX_DIM,
  THUMB_QUALITY,
  BLUR_MAX_DIM,
  BLUR_QUALITY,
} from "./thumbnail";

async function makeSolidPng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 120, g: 80, b: 40 },
    },
  })
    .png()
    .toBuffer();
}

test("exported constants match the documented defaults (480/75/16/30)", () => {
  assert.equal(THUMB_MAX_DIM, 480);
  assert.equal(THUMB_QUALITY, 75);
  assert.equal(BLUR_MAX_DIM, 16);
  assert.equal(BLUR_QUALITY, 30);
});

test("valid input produces a smaller webp thumbnail and a valid blur data URL", async () => {
  const input = await makeSolidPng(1000, 800);
  const { thumbnailBuffer, blurDataUrl } = await generateThumbnailAndBlur(input);

  assert.ok(Buffer.isBuffer(thumbnailBuffer));
  assert.ok(thumbnailBuffer.length > 0, "thumbnail buffer must be non-empty");
  assert.ok(
    thumbnailBuffer.length < input.length,
    "thumbnail must be smaller than the full-resolution input"
  );

  const meta = await sharp(thumbnailBuffer).metadata();
  assert.equal(meta.format, "webp");
  assert.ok(Math.max(meta.width ?? 0, meta.height ?? 0) <= THUMB_MAX_DIM);

  assert.ok(
    blurDataUrl.startsWith("data:image/webp;base64,"),
    `expected data:image/webp;base64, prefix, got: ${blurDataUrl.slice(0, 40)}`
  );
  const base64 = blurDataUrl.slice("data:image/webp;base64,".length);
  const blurBuf = Buffer.from(base64, "base64");
  assert.ok(blurBuf.length > 0);
  const blurMeta = await sharp(blurBuf).metadata();
  assert.equal(blurMeta.format, "webp");
  assert.ok(Math.max(blurMeta.width ?? 0, blurMeta.height ?? 0) <= BLUR_MAX_DIM);
});

test("aspect ratio is preserved for a landscape input (1000x800 -> 480x384), not distorted", async () => {
  const input = await makeSolidPng(1000, 800);
  const { thumbnailBuffer } = await generateThumbnailAndBlur(input);
  const meta = await sharp(thumbnailBuffer).metadata();
  assert.equal(meta.width, 480);
  assert.equal(meta.height, 384);
});

test("a perfectly square input still respects THUMB_MAX_DIM on both axes", async () => {
  const input = await makeSolidPng(1000, 1000);
  const { thumbnailBuffer } = await generateThumbnailAndBlur(input);
  const meta = await sharp(thumbnailBuffer).metadata();
  assert.equal(meta.width, 480);
  assert.equal(meta.height, 480);
});

test("a portrait input is clamped on its longest side (height), not its width", async () => {
  const input = await makeSolidPng(800, 1000);
  const { thumbnailBuffer } = await generateThumbnailAndBlur(input);
  const meta = await sharp(thumbnailBuffer).metadata();
  assert.equal(meta.height, 480);
  assert.equal(meta.width, 384);
});

test("an input already smaller than THUMB_MAX_DIM is not upscaled (withoutEnlargement)", async () => {
  const input = await makeSolidPng(100, 80);
  const { thumbnailBuffer } = await generateThumbnailAndBlur(input);
  const meta = await sharp(thumbnailBuffer).metadata();
  assert.equal(meta.width, 100, "must not be upscaled beyond its original width");
  assert.equal(meta.height, 80, "must not be upscaled beyond its original height");
});

test("empty input fails closed (rejects) rather than throwing past a caller's try/catch synchronously", async () => {
  await assert.rejects(() => generateThumbnailAndBlur(Buffer.alloc(0)));
});

test("corrupt/non-image input fails closed (rejects)", async () => {
  await assert.rejects(() => generateThumbnailAndBlur(Buffer.from("not an image")));
});

test("oversized input (> 40,000,000 px) fails closed (rejects) per limitInputPixels", async () => {
  // 6500 x 6200 = 40,300,000 px, just over the documented 40_000_000 limit.
  const input = await makeSolidPng(6500, 6200);
  await assert.rejects(() => generateThumbnailAndBlur(input));
});
