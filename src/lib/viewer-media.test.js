import test from "node:test";
import assert from "node:assert/strict";
import { VIEWER_THUMB_WIDTH, viewerRefs } from "./viewer-media.js";

test("an image needs only its original; a video needs its master URL and its poster", () => {
  assert.deepEqual(viewerRefs({ kind: "image", url: "/api/media/generations/a.jpg" }), [{ ref: "/api/media/generations/a.jpg" }]);
  assert.deepEqual(
    viewerRefs({ kind: "video", url: "/api/media/generations/v.mov", poster: "/api/media/generations/v.jpg" }),
    [{ ref: "/api/media/generations/v.mov" }, { ref: "/api/media/generations/v.jpg" }]
  );
  assert.deepEqual(viewerRefs({ kind: "video", url: "/api/media/generations/v.mov" }), [{ ref: "/api/media/generations/v.mov" }]);
  assert.deepEqual(viewerRefs({ kind: "image" }), []);
  assert.deepEqual(viewerRefs(null), []);
});

test("the stand-in width matches the grid card's thumbnail so its bytes are already cached", () => {
  assert.equal(VIEWER_THUMB_WIDTH, 480);
});
