/**
 * Trim the transparent border off a PNG logo and square it up.
 *
 * The brand mark shipped as a 2000×2000 canvas with the artwork occupying a
 * 485×459 island in the middle — 5.4% of the pixels opaque. Rendered into the
 * app's 32–36px square slots that made the visible mark about a quarter of the
 * space it was given, so the logo looked tiny and off-centre next to the
 * wordmark, and every page shipped ~110KB of empty alpha.
 *
 * Squaring matters as much as trimming: the mark is displayed in square boxes
 * (`h-8 w-8`, `h-9 w-9`), so a non-square source would be stretched by the
 * browser. The artwork is centred in a square canvas rather than resized into
 * one, which trims without distorting.
 *
 *   npx tsx scripts/crop-logo.ts                      # public/logo.png in place
 *   npx tsx scripts/crop-logo.ts in.png out.png       # explicit paths
 *
 * Idempotent: re-running on an already-trimmed file is a no-op beyond a
 * re-encode, because the bounding box is then already the whole canvas.
 */
import sharp from "sharp";

/** Alpha at or below this counts as background. Not zero: PNG edges are
 *  anti-aliased, and cutting at exactly 0 keeps a halo of near-invisible
 *  pixels that defeats the point of trimming. */
const ALPHA_THRESHOLD = 8;

/** Breathing room kept around the artwork, as a fraction of its longest side.
 *  Small but non-zero so the anti-aliased edge is never clipped flush. */
const MARGIN_RATIO = 0.015;

async function main() {
  const input = process.argv[2] ?? "public/logo.png";
  const output = process.argv[3] ?? input;

  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;

  let minX = W;
  let minY = H;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * C + 3] > ALPHA_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) {
    console.error("Every pixel is transparent — nothing to crop.");
    process.exit(1);
  }

  const contentW = maxX - minX + 1;
  const contentH = maxY - minY + 1;
  const margin = Math.round(Math.max(contentW, contentH) * MARGIN_RATIO);
  const side = Math.max(contentW, contentH) + margin * 2;

  // Centre the artwork in a square. `extract` cannot read outside the canvas,
  // so clamp the origin and let `extend` add back whatever the clamp ate —
  // otherwise a mark that sits near an edge throws instead of being centred.
  const wantLeft = minX - Math.round((side - contentW) / 2);
  const wantTop = minY - Math.round((side - contentH) / 2);
  const left = Math.max(0, wantLeft);
  const top = Math.max(0, wantTop);
  const right = Math.min(W, wantLeft + side);
  const bottom = Math.min(H, wantTop + side);

  const cropped = await sharp(input)
    .ensureAlpha()
    .extract({ left, top, width: right - left, height: bottom - top })
    .extend({
      left: left - wantLeft,
      top: top - wantTop,
      right: wantLeft + side - right,
      bottom: wantTop + side - bottom,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9 })
    .toBuffer();

  await sharp(cropped).toFile(output);
  const after = await sharp(output).metadata();

  console.log(`in    : ${input}  ${W}×${H}`);
  console.log(`bbox  : ${contentW}×${contentH} at (${minX}, ${minY})`);
  console.log(`out   : ${output}  ${after.width}×${after.height}`);
  console.log(
    `mark now fills ${((contentW / (after.width ?? 1)) * 100).toFixed(1)}% ` +
      `of the frame (was ${((contentW / W) * 100).toFixed(1)}%)`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
