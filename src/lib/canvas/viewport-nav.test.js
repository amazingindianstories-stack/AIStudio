/**
 * Unit tests for src/lib/canvas/viewport-nav.js: wheel and trackpad mapping
 * per navigation mode, zoom steps and the keyboard zoom keys. No DOM.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MAX_ZOOM, MIN_ZOOM, screenToWorld } from "./geometry.js";
import {
  WHEEL_ZOOM_MAX_DELTA,
  ZOOM_STEP,
  keyboardZoomDirection,
  looksLikeMouseWheel,
  wheelDeltaPx,
  wheelIntent,
  wheelViewport,
  wheelZoomFactor,
  zoomAboutCenter,
  zoomToLevel,
} from "./viewport-nav.js";

const close = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-6, `${message}: ${a} vs ${b}`);
const wheel = (fields) => ({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, ...fields });

// Chrome/Safari: trackpads report wheelDeltaY = -3 x deltaY; a wheel notch is 120.
const trackpadScroll = wheel({ deltaY: 12, wheelDeltaY: -36 });
const mouseNotch = wheel({ deltaY: 100, wheelDeltaY: -120 });
const macMouseNotch = wheel({ deltaY: 4.000244140625, wheelDeltaY: -12 * 10 });
const firefoxNotch = wheel({ deltaY: 3, deltaMode: 1 });

test("mouse wheels are told apart from trackpad scrolls", () => {
  assert.equal(looksLikeMouseWheel(mouseNotch), true);
  assert.equal(looksLikeMouseWheel(macMouseNotch), true);
  assert.equal(looksLikeMouseWheel(firefoxNotch), true);
  assert.equal(looksLikeMouseWheel(trackpadScroll), false);
  assert.equal(looksLikeMouseWheel(wheel({ deltaY: 40, wheelDeltaY: -120 })), false, "a trackpad delta that happens to be 120");
  assert.equal(looksLikeMouseWheel(wheel({ deltaX: 3, deltaY: 100, wheelDeltaY: -120 })), false, "sideways movement is a trackpad");
  assert.equal(looksLikeMouseWheel(wheel({ deltaY: 100 })), false, "no legacy delta: assume a trackpad");
});

test("line and page deltas convert to pixels", () => {
  assert.deepEqual(wheelDeltaPx(wheel({ deltaY: 3, deltaMode: 1 })), { dx: 0, dy: 48 });
  assert.deepEqual(wheelDeltaPx(wheel({ deltaX: 1, deltaMode: 2 }), 700), { dx: 700, dy: 0 });
  assert.deepEqual(wheelDeltaPx(wheel({ deltaX: 5, deltaY: -7 })), { dx: 5, dy: -7 });
});

test("Cmd or Ctrl + wheel (and a pinch) zooms in every mode", () => {
  for (const mode of ["auto", "mouse", "trackpad"]) {
    assert.deepEqual(wheelIntent(wheel({ deltaY: -4, ctrlKey: true }), mode), { type: "zoom", delta: -4 }, mode);
    assert.deepEqual(wheelIntent(wheel({ deltaY: 100, metaKey: true, wheelDeltaY: -120 }), mode), { type: "zoom", delta: 100 }, mode);
  }
});

test("trackpad mode pans with two fingers, even for wheel-like events", () => {
  assert.deepEqual(wheelIntent(wheel({ deltaX: 10, deltaY: 20 }), "trackpad"), { type: "pan", dx: 10, dy: 20 });
  assert.deepEqual(wheelIntent(mouseNotch, "trackpad"), { type: "pan", dx: 0, dy: 100 });
});

test("mouse mode zooms with the wheel and pans sideways with Shift", () => {
  assert.deepEqual(wheelIntent(trackpadScroll, "mouse"), { type: "zoom", delta: 12 });
  assert.deepEqual(wheelIntent(wheel({ deltaY: 100, shiftKey: true }), "mouse"), { type: "pan", dx: 100, dy: 0 });
  // Browsers that already turn Shift + wheel into a sideways delta.
  assert.deepEqual(wheelIntent(wheel({ deltaX: 100, shiftKey: true }), "mouse"), { type: "pan", dx: 100, dy: 0 });
  assert.deepEqual(wheelIntent(wheel({ deltaX: 30 }), "mouse"), { type: "pan", dx: 30, dy: 0 }, "a tilt wheel pans sideways");
});

test("auto mode zooms for a mouse wheel and pans for a trackpad", () => {
  assert.equal(wheelIntent(mouseNotch, "auto").type, "zoom");
  assert.equal(wheelIntent(firefoxNotch, "auto").type, "zoom");
  assert.deepEqual(wheelIntent(trackpadScroll, "auto"), { type: "pan", dx: 0, dy: 12 });
  assert.deepEqual(wheelIntent(wheel({ deltaY: 900 }), "auto"), { type: "pan", dx: 0, dy: 900 });
});

test("wheel zoom steps are capped, so one notch is a comfortable step", () => {
  close(wheelZoomFactor(-4), Math.exp(0.04), "small pinch passes through");
  close(wheelZoomFactor(100), Math.exp(-WHEEL_ZOOM_MAX_DELTA * 0.01), "notch out is capped");
  close(wheelZoomFactor(-100), Math.exp(WHEEL_ZOOM_MAX_DELTA * 0.01), "notch in is capped");
  assert.ok(wheelZoomFactor(-100) < 1.3);
});

test("wheel zoom keeps the world point under the cursor and clamps to 10%-2000%", () => {
  const vp = { x: 100, y: 50, zoom: 1 };
  const point = { x: 300, y: 200 };
  const next = wheelViewport(vp, point, wheel({ deltaY: -100, ctrlKey: true }), "auto");
  assert.ok(next.zoom > 1);
  const before = screenToWorld(point, vp);
  const after = screenToWorld(point, next);
  close(after.x, before.x, "x stays under cursor");
  close(after.y, before.y, "y stays under cursor");

  let deep = vp;
  for (let i = 0; i < 400; i += 1) deep = wheelViewport(deep, point, wheel({ deltaY: -100, ctrlKey: true }), "auto");
  assert.equal(deep.zoom, MAX_ZOOM);
  let far = vp;
  for (let i = 0; i < 400; i += 1) far = wheelViewport(far, point, wheel({ deltaY: 100, ctrlKey: true }), "auto");
  assert.equal(far.zoom, MIN_ZOOM);
});

test("wheel panning moves by screen pixels at any zoom; no movement returns the same viewport", () => {
  const vp = { x: 0, y: 0, zoom: 2 };
  assert.deepEqual(wheelViewport(vp, { x: 0, y: 0 }, wheel({ deltaX: 40, deltaY: -20 }), "trackpad"), { x: 20, y: -10, zoom: 2 });
  assert.equal(wheelViewport(vp, { x: 0, y: 0 }, wheel({}), "trackpad"), vp);
  assert.equal(wheelViewport(vp, { x: 0, y: 0 }, wheel({ ctrlKey: true }), "trackpad"), vp);
});

test("zoom steps keep the view centre and reach the full range", () => {
  const size = { w: 800, h: 600 };
  const vp = { x: 10, y: 20, zoom: 1 };
  const center = screenToWorld({ x: 400, y: 300 }, vp);
  const inStep = zoomAboutCenter(vp, ZOOM_STEP, size);
  close(inStep.zoom, ZOOM_STEP, "one step");
  const after = screenToWorld({ x: 400, y: 300 }, inStep);
  close(after.x, center.x, "centre x");
  close(after.y, center.y, "centre y");

  let z = vp;
  for (let i = 0; i < 40; i += 1) z = zoomAboutCenter(z, ZOOM_STEP, size);
  assert.equal(z.zoom, MAX_ZOOM, "2000% is reachable");
  const level = zoomToLevel({ x: 0, y: 0, zoom: 3 }, 1, size);
  assert.equal(level.zoom, 1);
  close(screenToWorld({ x: 400, y: 300 }, level).x, 400 / 3, "100% keeps the centre");
});

test("keyboard zoom keys: Cmd/Ctrl with plus, equals, minus and the numpad", () => {
  const key = (fields) => ({ metaKey: false, ctrlKey: false, altKey: false, key: "", code: "", ...fields });
  assert.equal(keyboardZoomDirection(key({ metaKey: true, key: "=", code: "Equal" })), 1);
  assert.equal(keyboardZoomDirection(key({ ctrlKey: true, key: "+", code: "Equal" })), 1);
  assert.equal(keyboardZoomDirection(key({ ctrlKey: true, key: "+", code: "NumpadAdd" })), 1);
  assert.equal(keyboardZoomDirection(key({ metaKey: true, key: "-", code: "Minus" })), -1);
  assert.equal(keyboardZoomDirection(key({ metaKey: true, key: "_", code: "Minus" })), -1);
  assert.equal(keyboardZoomDirection(key({ ctrlKey: true, key: "-", code: "NumpadSubtract" })), -1);
  assert.equal(keyboardZoomDirection(key({ key: "=", code: "Equal" })), 0, "needs Cmd or Ctrl");
  assert.equal(keyboardZoomDirection(key({ metaKey: true, altKey: true, key: "=" })), 0);
  assert.equal(keyboardZoomDirection(key({ metaKey: true, key: "0", code: "Digit0" })), 0);
});
