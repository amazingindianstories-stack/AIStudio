import assert from "node:assert/strict";
import test from "node:test";
import {
  __resetCanvasImageLoader,
  MAX_CONCURRENT_FULL_LOADS,
  MAX_CONCURRENT_THUMB_LOADS,
  requestCanvasImageSlot,
} from "./image-loader.js";

test("prioritizes visible viewport images over overscan, initial paints over upgrades, and center-first", async () => {
  __resetCanvasImageLoader();
  // Saturate the thumbnail pool first
  const blockers = [];
  for (let i = 0; i < MAX_CONCURRENT_THUMB_LOADS; i += 1) {
    const req = requestCanvasImageSlot({ tier: 256, inViewport: true, distanceSq: 0 });
    blockers.push(await req.acquired);
  }

  const order = [];
  const queued = [
    ["overscan", requestCanvasImageSlot({ tier: 256, inViewport: false, isUpgrade: false, distanceSq: 10 })],
    ["upgrade", requestCanvasImageSlot({ tier: 512, inViewport: true, isUpgrade: true, distanceSq: 5 })],
    ["far-center", requestCanvasImageSlot({ tier: 256, inViewport: true, isUpgrade: false, distanceSq: 900 })],
    ["near-center", requestCanvasImageSlot({ tier: 256, inViewport: true, isUpgrade: false, distanceSq: 25 })],
    ["tier-512", requestCanvasImageSlot({ tier: 512, inViewport: true, isUpgrade: false, distanceSq: 0 })],
  ];

  const done = queued.map(([name, req]) =>
    req.acquired.then((release) => {
      order.push(name);
      release();
    })
  );

  // Release one blocker at a time so each drain picks strictly the highest priority waiter
  for (const release of blockers) release();
  await Promise.all(done);

  assert.deepEqual(order, ["near-center", "far-center", "tier-512", "upgrade", "overscan"]);
  __resetCanvasImageLoader();
});

test("full-resolution pool is isolated from thumbnails and respects its smaller cap", async () => {
  __resetCanvasImageLoader();
  const fullReleases = [];
  for (let i = 0; i < MAX_CONCURRENT_FULL_LOADS; i += 1) {
    fullReleases.push(await requestCanvasImageSlot({ tier: null, inViewport: true }).acquired);
  }

  let extraFullStarted = false;
  const extraFull = requestCanvasImageSlot({ tier: null, inViewport: true });
  extraFull.acquired.then((release) => {
    extraFullStarted = true;
    release();
  });

  // Thumbnails still start immediately even while full-res pool is full
  const thumbRelease = await requestCanvasImageSlot({ tier: 256, inViewport: true }).acquired;
  assert.equal(extraFullStarted, false);

  thumbRelease();
  fullReleases.forEach((r) => r());
  await extraFull.acquired;
  assert.equal(extraFullStarted, true);
  __resetCanvasImageLoader();
});

test("cancelling a queued request removes it without starving later waiters", async () => {
  __resetCanvasImageLoader();
  const blockers = [];
  for (let i = 0; i < MAX_CONCURRENT_THUMB_LOADS; i += 1) {
    blockers.push(await requestCanvasImageSlot({ tier: 256 }).acquired);
  }

  let cancelledStarted = false;
  const cancelled = requestCanvasImageSlot({ tier: 256, inViewport: true, distanceSq: 0 });
  cancelled.acquired.then((r) => {
    cancelledStarted = true;
    r();
  });

  let survivorStarted = false;
  const survivor = requestCanvasImageSlot({ tier: 256, inViewport: true, distanceSq: 100 });
  const survivorDone = survivor.acquired.then((r) => {
    survivorStarted = true;
    r();
  });

  cancelled.cancel();
  blockers[0]();
  await survivorDone;
  assert.equal(cancelledStarted, false);
  assert.equal(survivorStarted, true);

  blockers.slice(1).forEach((r) => r());
  __resetCanvasImageLoader();
});

test("waiting entries re-read live priority so a pan reorders the queue without re-rendering", async () => {
  __resetCanvasImageLoader();
  const blockers = [];
  for (let i = 0; i < MAX_CONCURRENT_THUMB_LOADS; i += 1) {
    blockers.push(await requestCanvasImageSlot({ tier: 256 }).acquired);
  }
  let panned = false;
  const order = [];
  const near = requestCanvasImageSlot({ tier: 256, distanceSq: 10, priority: () => ({ inViewport: true, distanceSq: panned ? 9000 : 10 }) });
  const far = requestCanvasImageSlot({ tier: 256, distanceSq: 9000, priority: () => ({ inViewport: true, distanceSq: panned ? 10 : 9000 }) });
  const done = [["near", near], ["far", far]].map(([name, req]) => req.acquired.then((release) => { order.push(name); return release; }));
  panned = true;
  blockers.shift()();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(order, ["far"]);
  blockers.forEach((release) => release());
  (await Promise.all(done)).forEach((release) => release());
});
