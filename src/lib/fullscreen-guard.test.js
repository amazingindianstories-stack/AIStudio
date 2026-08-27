import assert from "node:assert/strict";
import test from "node:test";
import {
  hasFullscreenMedia,
  settleFullscreenBeforeMediaMutation,
} from "./fullscreen-guard.js";

test("no fullscreen media requires no browser mutation", async () => {
  const changed = await settleFullscreenBeforeMediaMutation({
    fullscreenElement: null,
    querySelector: () => null,
  });
  assert.equal(changed, false);
});

test("standard fullscreen exits before two stabilizing paint frames", async (t) => {
  const events = [];
  const original = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => {
    events.push("frame");
    callback();
  };
  t.after(() => {
    globalThis.requestAnimationFrame = original;
  });

  const changed = await settleFullscreenBeforeMediaMutation({
    fullscreenElement: {},
    exitFullscreen: async () => events.push("exit"),
  });
  assert.equal(changed, true);
  assert.deepEqual(events, ["exit", "frame", "frame"]);
});

test("Safari native video fullscreen uses its compatible exit path", async (t) => {
  const events = [];
  const original = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => {
    events.push("frame");
    callback();
  };
  t.after(() => {
    globalThis.requestAnimationFrame = original;
  });
  const video = {
    webkitDisplayingFullscreen: true,
    webkitExitFullscreen: () => events.push("exit"),
  };
  const changed = await settleFullscreenBeforeMediaMutation({
    fullscreenElement: null,
    querySelector: () => video,
  });
  assert.equal(changed, true);
  assert.deepEqual(events, ["exit", "frame", "frame"]);
});

test("fullscreen detection covers standard and Safari native video modes", () => {
  assert.equal(hasFullscreenMedia({ fullscreenElement: {} }), true);
  assert.equal(
    hasFullscreenMedia({
      fullscreenElement: null,
      querySelector: () => ({ webkitDisplayingFullscreen: true }),
    }),
    true
  );
});

test("a failed exit never permits an active fullscreen element to be unmounted", async (t) => {
  const original = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => callback();
  t.after(() => {
    globalThis.requestAnimationFrame = original;
  });
  const exitError = new Error("exit failed");
  await assert.rejects(
    settleFullscreenBeforeMediaMutation({
      fullscreenElement: {},
      exitFullscreen: async () => {
        throw exitError;
      },
    }),
    exitError
  );
});
