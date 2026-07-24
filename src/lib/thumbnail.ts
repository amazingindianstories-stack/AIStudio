import sharp from "sharp";

/**
 * Pure, storage-agnostic thumbnail + blur-placeholder generator. No storage/DB
 * imports here on purpose — unit-testable without mocks (see thumbnail.test.ts).
 * Mirrors the on-the-fly `?w=` resize route's constants so both code paths
 * produce visually consistent output.
 */

// Constants — mirror the on-the-fly route so the two code paths look identical.
export const THUMB_MAX_DIM = 480; // longest side, px
export const THUMB_QUALITY = 75; // webp quality (matches media route)
export const BLUR_MAX_DIM = 16; // longest side of the LQIP, px
export const BLUR_QUALITY = 30; // webp quality for the LQIP

export interface ThumbnailResult {
  /** Small webp thumbnail bytes, ready to upload. */
  thumbnailBuffer: Buffer;
  /** Tiny inline placeholder, e.g. "data:image/webp;base64,AAAA...". */
  blurDataUrl: string;
}

/**
 * Produce a <=480px-longest-side webp thumbnail and a ~16px base64 blur
 * placeholder from arbitrary image bytes. Throws on empty/corrupt/oversized
 * input (sharp `failOn: "error"`, `limitInputPixels`) — callers treat this as
 * best-effort and swallow the throw.
 */
export async function generateThumbnailAndBlur(input: Buffer): Promise<ThumbnailResult> {
  if (!input.length) throw new Error("Thumbnail input is empty.");

  const source = () =>
    sharp(input, {
      failOn: "error",
      limitInputPixels: 40_000_000,
      sequentialRead: true,
    }).rotate();

  const thumbnailBuffer = await source()
    .resize(THUMB_MAX_DIM, THUMB_MAX_DIM, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: THUMB_QUALITY })
    .toBuffer();

  const blurBuffer = await source()
    .resize(BLUR_MAX_DIM, BLUR_MAX_DIM, { fit: "inside" })
    .webp({ quality: BLUR_QUALITY })
    .toBuffer();

  return {
    thumbnailBuffer,
    blurDataUrl: `data:image/webp;base64,${blurBuffer.toString("base64")}`,
  };
}
