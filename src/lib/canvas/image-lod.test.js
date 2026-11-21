import assert from "node:assert/strict";
import test from "node:test";
import { IMAGE_LOAD_OVERSCAN_PX, imageLoadVisibility, imageViewportKey, selectImageTier, tierRank } from "./image-lod.js";

test("selectImageTier chooses smallest WebP tier covering physical pixels and swaps to full above 1280px", () => {
  // Zoomed-out overview: 320px node at 0.15x zoom => 48px physical => 256 tier
  assert.equal(selectImageTier({ renderedW: 320, zoom: 0.15, dpr: 1 }), 256);
  assert.equal(selectImageTier({ renderedW: 320, zoom: 0.15, dpr: 2 }), 256);
  // Boundary at 256px
  assert.equal(selectImageTier({ renderedW: 256, zoom: 1, dpr: 1 }), 256);
  assert.equal(selectImageTier({ renderedW: 257, zoom: 1, dpr: 1 }), 512);
  // 100% zoom on a 320px card at 1x => 320px => 512; at 2x retina => 640px => 1280
  assert.equal(selectImageTier({ renderedW: 320, zoom: 1, dpr: 1 }), 512);
  assert.equal(selectImageTier({ renderedW: 320, zoom: 1, dpr: 2 }), 1280);
  // Close-up zoom > 1280px physical => full original (null)
  assert.equal(selectImageTier({ renderedW: 320, zoom: 4.5, dpr: 1 }), null);
  assert.equal(selectImageTier({ renderedW: 700, zoom: 1, dpr: 2 }), null);
  // DPR is clamped to 2x so 3x phones don't overshoot unnecessarily
  assert.equal(selectImageTier({ renderedW: 120, zoom: 1, dpr: 3 }), 256);
});

test("selectImageTier clamps thumbnails to naturalW when original is already small", () => {
  assert.equal(selectImageTier({ renderedW: 600, zoom: 1, dpr: 1, naturalW: 200 }), 256);
  assert.equal(selectImageTier({ renderedW: 1000, zoom: 1, dpr: 1, naturalW: 400 }), 512);
  // Still allows full-res swap when zoomed past 1280px
  assert.equal(selectImageTier({ renderedW: 1400, zoom: 1, dpr: 1, naturalW: 400 }), null);
});

test("selectImageTier upgrades immediately on zoom-in and applies hysteresis on zoom-out", () => {
  // Upgrading 256 -> 512 -> 1280 -> null happens immediately
  assert.equal(selectImageTier({ renderedW: 320, zoom: 1, dpr: 1, currentTier: 256 }), 512);
  assert.equal(selectImageTier({ renderedW: 800, zoom: 1, dpr: 1, currentTier: 512 }), 1280);
  assert.equal(selectImageTier({ renderedW: 1500, zoom: 1, dpr: 1, currentTier: 1280 }), null);

  // Small zoom-out from 512 keeps 512 (no redundant re-fetch)
  assert.equal(selectImageTier({ renderedW: 200, zoom: 1, dpr: 1, currentTier: 512 }), 512);

  // Moderate zoom-out from full-res keeps full-res above 960px, reclaims below 960px
  assert.equal(selectImageTier({ renderedW: 1100, zoom: 1, dpr: 1, currentTier: null }), null);
  assert.equal(selectImageTier({ renderedW: 400, zoom: 1, dpr: 1, currentTier: null }), 512);

  // Zooming way out from 1280 to overview reclaims below 280px
  assert.equal(selectImageTier({ renderedW: 400, zoom: 1, dpr: 1, currentTier: 1280 }), 1280);
  assert.equal(selectImageTier({ renderedW: 100, zoom: 1, dpr: 1, currentTier: 1280 }), 256);
});

test("selectImageTier promotes cropMode above 960px to full resolution", () => {
  assert.equal(selectImageTier({ renderedW: 1000, zoom: 1, dpr: 1, cropMode: true }), null);
  assert.equal(selectImageTier({ renderedW: 400, zoom: 1, dpr: 1, cropMode: true }), 512);
});

test("imageLoadVisibility separates viewport, load overscan, and far-cull nodes with center-first distance", () => {
  const viewport = { x: 0, y: 0, zoom: 1 };
  const size = { w: 1000, h: 800 };

  const center = imageLoadVisibility({ x: 450, y: 350, w: 100, h: 100 }, viewport, size);
  const corner = imageLoadVisibility({ x: 0, y: 0, w: 100, h: 100 }, viewport, size);
  const near = imageLoadVisibility({ x: 1000 + IMAGE_LOAD_OVERSCAN_PX - 20, y: 350, w: 100, h: 100 }, viewport, size);
  const far = imageLoadVisibility({ x: 1000 + IMAGE_LOAD_OVERSCAN_PX + 50, y: 350, w: 100, h: 100 }, viewport, size);

  assert.equal(center.shouldLoad, true);
  assert.equal(center.inViewport, true);
  assert.equal(center.distanceSq, 0);

  assert.equal(corner.shouldLoad, true);
  assert.equal(corner.inViewport, true);
  assert.ok(corner.distanceSq > center.distanceSq);

  assert.equal(near.shouldLoad, true);
  assert.equal(near.inViewport, false);

  assert.equal(far.shouldLoad, false);
  assert.equal(far.inViewport, false);
});

test("tierRank orders tiers from smallest thumbnail to full original", () => {
  assert.deepEqual([256, 512, 1280, null].map(tierRank), [0, 1, 2, 3]);
});

test("imageViewportKey stays equal across pans and zooms that keep a node's visibility and tier band", () => {
  const node = { x: 0, y: 0, w: 320, h: 200 };
  const size = { w: 1600, h: 900 };
  const key = (viewport) => imageViewportKey(node, viewport, size);
  const base = key({ x: 0, y: 0, zoom: 0.5 });
  assert.equal(key({ x: -40, y: 25, zoom: 0.5 }), base);
  assert.equal(key({ x: 0, y: 0, zoom: 0.55 }), base);
  assert.notEqual(key({ x: 0, y: 0, zoom: 1 }), base);
  assert.notEqual(key({ x: -100000, y: 0, zoom: 0.5 }), base);
  assert.notEqual(key(null), base);
  for (const zoom of [0.1, 0.3, 0.6, 0.85, 1.5, 3, 5]) {
    for (const nearZoom of [zoom * 0.98, zoom * 1.02]) {
      if (key({ x: 0, y: 0, zoom }) === key({ x: 0, y: 0, zoom: nearZoom })) {
        for (const currentTier of [undefined, 256, 512, 1280, null]) {
          assert.equal(
            selectImageTier({ renderedW: 320, zoom, currentTier }),
            selectImageTier({ renderedW: 320, zoom: nearZoom, currentTier })
          );
        }
      }
    }
  }
});

test("imageViewportKey and selectImageTier agree at every tier and downgrade edge, including crop mode", () => {
  const node = { x: 0, y: 0, w: 100, h: 100 };
  const size = { w: 1600, h: 900 };
  const edges = [256, 280, 512, 960, 1280];
  const pxs = edges.flatMap((edge) => [edge - 1, edge - 0.001, edge, edge + 0.001, edge + 1]);
  for (const cropMode of [false, true]) {
    for (const a of pxs) {
      for (const b of pxs) {
        const keyA = imageViewportKey(node, { x: 0, y: 0, zoom: a / 100 }, size, { cropMode });
        const keyB = imageViewportKey(node, { x: 0, y: 0, zoom: b / 100 }, size, { cropMode });
        if (keyA !== keyB) continue;
        for (const currentTier of [undefined, 256, 512, 1280, null]) {
          assert.equal(
            selectImageTier({ renderedW: 100, zoom: a / 100, cropMode, currentTier }),
            selectImageTier({ renderedW: 100, zoom: b / 100, cropMode, currentTier }),
            `${a} vs ${b} crop=${cropMode} current=${currentTier}`
          );
        }
      }
    }
  }
});
