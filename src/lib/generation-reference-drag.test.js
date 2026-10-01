import test from "node:test";
import assert from "node:assert/strict";
import { validateGenerationReference } from "./generation-reference-drag";

test("validateGenerationReference handles invalid item states and depth mode", () => {
  assert.equal(validateGenerationReference(null).valid, false);
  assert.equal(validateGenerationReference(undefined).valid, false);

  assert.match(
    validateGenerationReference({ status: "running" }).reason,
    /still processing/
  );
  assert.match(
    validateGenerationReference({ status: "queued" }).reason,
    /still processing/
  );
  assert.match(
    validateGenerationReference({ status: "failed" }).reason,
    /Failed generations cannot be used/
  );
  assert.match(
    validateGenerationReference({ status: "succeeded" }).reason,
    /no media URL/
  );

  const validImage = {
    id: "img-1",
    kind: "image",
    status: "succeeded",
    url: "/api/media/generations/1.png",
  };
  assert.match(
    validateGenerationReference(validImage, { mode: "depth" }).reason,
    /Depth Map mode only accepts direct video uploads/
  );
});

test("validateGenerationReference for image generations in image mode", () => {
  const item = {
    id: "img-1",
    kind: "image",
    status: "succeeded",
    url: "/api/media/generations/1.png",
  };

  // Seedream 5.0 Pro (max 10)
  const seedreamValid = validateGenerationReference(item, {
    mode: "image",
    model: "Seedream 5.0 Pro",
    referenceImages: [],
  });
  assert.equal(seedreamValid.valid, true);
  assert.equal(seedreamValid.action, "add-image-ref");

  const seedreamFull = validateGenerationReference(item, {
    mode: "image",
    model: "Seedream 5.0 Pro",
    referenceImages: Array(10).fill("/api/media/other.png"),
  });
  assert.equal(seedreamFull.valid, false);
  assert.match(seedreamFull.reason, /at most 10 reference images/);

  // Kling Image 3.0 (max 1)
  const klingValid = validateGenerationReference(item, {
    mode: "image",
    model: "Kling Image 3.0",
    referenceImages: [],
  });
  assert.equal(klingValid.valid, true);
  assert.equal(klingValid.action, "add-image-ref");

  const klingFull = validateGenerationReference(item, {
    mode: "image",
    model: "Kling Image 3.0",
    referenceImages: ["/api/media/other.png"],
  });
  assert.equal(klingFull.valid, false);
  assert.match(klingFull.reason, /at most 1 reference image/);

  // Duplicate check
  const duplicate = validateGenerationReference(item, {
    mode: "image",
    model: "Nano Banana Pro",
    referenceImages: [item.url],
  });
  assert.equal(duplicate.valid, false);
  assert.match(duplicate.reason, /already added/);
});

test("validateGenerationReference for image generations in video mode", () => {
  const item = {
    id: "img-1",
    kind: "image",
    status: "succeeded",
    url: "/api/media/generations/1.png",
  };

  // Seedance 2.0 (max 9)
  const seedanceValid = validateGenerationReference(item, {
    mode: "video",
    model: "Seedance 2.0",
    referenceImages: [],
  });
  assert.equal(seedanceValid.valid, true);
  assert.equal(seedanceValid.action, "add-image-ref");

  const seedanceFull = validateGenerationReference(item, {
    mode: "video",
    model: "Seedance 2.0",
    referenceImages: Array(9).fill("/api/media/other.png"),
  });
  assert.equal(seedanceFull.valid, false);
  assert.match(seedanceFull.reason, /at most 9 reference images/);

  // Seedance 2.5 (max 30)
  const seedance25Valid = validateGenerationReference(item, {
    mode: "video",
    model: "Seedance 2.5",
    referenceImages: Array(29).fill("/api/media/other.png"),
  });
  assert.equal(seedance25Valid.valid, true);

  const seedance25Full = validateGenerationReference(item, {
    mode: "video",
    model: "Seedance 2.5",
    referenceImages: Array(30).fill("/api/media/other.png"),
  });
  assert.equal(seedance25Full.valid, false);
  assert.match(seedance25Full.reason, /at most 30 reference images/);
});

test("validateGenerationReference for video generations", () => {
  const videoItem = {
    id: "vid-1",
    kind: "video",
    status: "succeeded",
    url: "/api/media/generations/1.mp4",
  };

  // Dropping into Image Mode is rejected with actionable message
  const imageModeDrop = validateGenerationReference(videoItem, {
    mode: "image",
    model: "Seedream 5.0 Pro",
  });
  assert.equal(imageModeDrop.valid, false);
  assert.match(imageModeDrop.reason, /image model and does not accept video references/);

  // Dropping into video mode without videoReference support (Omni)
  const omniDrop = validateGenerationReference(videoItem, {
    mode: "video",
    model: "Gemini Omni Flash",
  });
  assert.equal(omniDrop.valid, false);
  assert.match(omniDrop.reason, /does not support video references/);

  // Dropping into Seedance 2.0 (supports videoReference, max 3)
  const seedance20Valid = validateGenerationReference(videoItem, {
    mode: "video",
    model: "Seedance 2.0",
    referenceVideos: [],
  });
  assert.equal(seedance20Valid.valid, true);
  assert.equal(seedance20Valid.action, "add-video-ref");

  const seedance20Full = validateGenerationReference(videoItem, {
    mode: "video",
    model: "Seedance 2.0",
    referenceVideos: ["clip1", "clip2", "clip3"],
  });
  assert.equal(seedance20Full.valid, false);
  assert.match(seedance20Full.reason, /at most 3 reference clips/);

  // Duplicate video check
  const duplicate = validateGenerationReference(videoItem, {
    mode: "video",
    model: "Seedance 2.0",
    referenceVideos: [videoItem.url],
  });
  assert.equal(duplicate.valid, false);
  assert.match(duplicate.reason, /already added as a reference/);
});
