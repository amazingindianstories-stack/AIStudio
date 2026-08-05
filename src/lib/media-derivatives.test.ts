import test from "node:test";
import assert from "node:assert/strict";
import {
  isThumbnailable,
  keyExtension,
  originalKeyFromThumb,
  THUMB_LADDER,
  thumbKey,
  thumbLadderWidth,
} from "./media-derivatives";

test("every width the app actually requests maps onto the ladder", () => {
  // The real call sites: AssetLibrary 128/160, CanvasAssetPanel 320,
  // DetailModal 320, MediaCard 480, VideoRefPicker 480, ImageNode 1024,
  // ConversationPanel 1200. If a new width appears that lands above the top
  // step it silently starts serving full-res originals, so pin them.
  for (const w of [128, 160, 320, 480, 1024, 1200]) {
    const step = thumbLadderWidth(w);
    assert.ok(step !== null, `no ladder step serves ${w}`);
    assert.ok(step >= w, `${w} would be upscaled from ${step}`);
  }
});

test("picks the smallest step that covers the request", () => {
  assert.equal(thumbLadderWidth(1), 512);
  assert.equal(thumbLadderWidth(512), 512);
  assert.equal(thumbLadderWidth(513), 1280);
  assert.equal(thumbLadderWidth(1280), 1280);
});

test("a request wider than the ladder serves the original, never an upscale", () => {
  assert.equal(thumbLadderWidth(1281), null);
  assert.equal(thumbLadderWidth(1600), null);
});

test("thumbnails are generated only for raster images", () => {
  assert.equal(isThumbnailable("generations/a.png"), true);
  assert.equal(isThumbnailable("generations/a.JPG"), true);
  assert.equal(isThumbnailable("assets/b.webp"), true);
  assert.equal(isThumbnailable("generations/a.mp4"), false);
  assert.equal(isThumbnailable("generations/a.webm"), false);
  assert.equal(isThumbnailable("settings/token.json"), false);
  assert.equal(isThumbnailable("generations/noext"), false);
});

test("derivatives never recurse into themselves", () => {
  const derived = thumbKey("generations/a.png", 512);
  assert.equal(isThumbnailable(derived), false);
});

test("thumbKey round-trips through originalKeyFromThumb", () => {
  for (const key of [
    "generations/8b1d-4c.png",
    "assets/x.jpeg",
    "references/id-0.webp",
    "canvas/deep/nested/name.with.dots.png",
  ]) {
    for (const width of THUMB_LADDER) {
      const round = originalKeyFromThumb(thumbKey(key, width));
      assert.deepEqual(round, { key, width });
    }
  }
});

test("originalKeyFromThumb rejects anything that is not a derivative", () => {
  assert.equal(originalKeyFromThumb("generations/a.png"), null);
  assert.equal(originalKeyFromThumb("thumbs/"), null);
  assert.equal(originalKeyFromThumb("thumbs/512"), null);
  assert.equal(originalKeyFromThumb("thumbs/notanumber/a.png.webp"), null);
  // Not a webp payload — so not something this module wrote.
  assert.equal(originalKeyFromThumb("thumbs/512/a.png"), null);
});

test("the thumbs namespace cannot be used to name a protected object", () => {
  // The route's denylist test resolves through this; if the round-trip ever
  // stopped recovering the original, `thumbs/512/settings/…` would read as an
  // allowed key. See isProtectedMediaKey in storage.ts.
  const smuggled = thumbKey("settings/higgsfield-token.json", 512);
  assert.equal(smuggled.startsWith("settings/"), false);
  assert.equal(originalKeyFromThumb(smuggled)?.key, "settings/higgsfield-token.json");
});

test("keyExtension reads the last dot of the basename only", () => {
  assert.equal(keyExtension("a/b.c/d.png"), "png");
  assert.equal(keyExtension("a/b.png/c"), "");
  assert.equal(keyExtension("name.with.dots.JPEG"), "jpeg");
});
