/**
 * Unit tests for src/lib/canvas/touch-gestures.js: the pure pinch, double-tap
 * and tap-recognition maths behind the board's touch gestures. No DOM.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MAX_ZOOM, MIN_ZOOM, screenToWorld } from "./geometry.js";
import {
  DOUBLE_TAP_MS,
  DOUBLE_TAP_SLOP_PX,
  DOUBLE_TAP_ZOOM_FACTOR,
  LONG_PRESS_MS,
  TOUCH_SLOP_PX,
  doubleTapAction,
  doubleTapViewport,
  isDoubleTap,
  isTap,
  movedPastSlop,
  pinchOf,
  pinchViewport,
  swipeZoomViewport,
  zoomAroundPoint,
} from "./touch-gestures.js";

const close = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-6, `${message}: ${a} vs ${b}`);
const samePoint = (a, b, message) => {
  close(a.x, b.x, `${message} x`);
  close(a.y, b.y, `${message} y`);
};

test("zoomAroundPoint keeps the world point under the screen point fixed", () => {
  const vp = { x: 100, y: 50, zoom: 1 };
  const screen = { x: 300, y: 200 };
  const before = screenToWorld(screen, vp);
  const next = zoomAroundPoint(vp, screen, 2.5);
  assert.equal(next.zoom, 2.5);
  samePoint(screenToWorld(screen, next), before, "anchor");
});

test("zoomAroundPoint clamps to the shared zoom bounds", () => {
  const vp = { x: 0, y: 0, zoom: 1 };
  assert.equal(zoomAroundPoint(vp, { x: 10, y: 10 }, 99).zoom, MAX_ZOOM);
  assert.equal(zoomAroundPoint(vp, { x: 10, y: 10 }, 0.0001).zoom, MIN_ZOOM);
});

test("pinchOf reports the centre and finger spread", () => {
  const pinch = pinchOf({ x: 100, y: 100 }, { x: 160, y: 180 });
  assert.deepEqual(pinch.center, { x: 130, y: 140 });
  assert.equal(pinch.distance, 100);
});

test("pinchViewport scales zoom by finger spread around the pinch centre", () => {
  const start = { x: 20, y: 30, zoom: 1 };
  const startPinch = pinchOf({ x: 100, y: 200 }, { x: 200, y: 200 });
  const anchor = screenToWorld(startPinch.center, start);
  const spread = pinchOf({ x: 50, y: 200 }, { x: 250, y: 200 }); // same centre, doubled spread
  const next = pinchViewport(start, startPinch, spread);
  close(next.zoom, 2, "zoom doubles");
  samePoint(screenToWorld(spread.center, next), anchor, "centre fixed");
});

test("pinchViewport pans when both fingers move together", () => {
  const start = { x: 0, y: 0, zoom: 1 };
  const startPinch = pinchOf({ x: 100, y: 100 }, { x: 200, y: 100 });
  const moved = pinchOf({ x: 140, y: 160 }, { x: 240, y: 160 }); // +40, +60, same spread
  const next = pinchViewport(start, startPinch, moved);
  close(next.zoom, 1, "zoom unchanged");
  close(next.x, -40, "panned right so content follows the fingers");
  close(next.y, -60, "panned down");
});

test("pinchViewport combines zoom and pan while keeping the anchor under the centre", () => {
  const start = { x: -300, y: 120, zoom: 0.5 };
  const startPinch = pinchOf({ x: 80, y: 300 }, { x: 180, y: 320 });
  const anchor = screenToWorld(startPinch.center, start);
  const now = pinchOf({ x: 30, y: 400 }, { x: 330, y: 460 });
  const next = pinchViewport(start, startPinch, now);
  close(next.zoom, 0.5 * (now.distance / startPinch.distance), "zoom follows spread ratio");
  samePoint(screenToWorld(now.center, next), anchor, "anchor follows the centre");
});

test("pinchViewport is computed from the gesture start, so it does not drift", () => {
  const start = { x: 10, y: 10, zoom: 1 };
  const startPinch = pinchOf({ x: 100, y: 100 }, { x: 200, y: 100 });
  const a = pinchViewport(start, startPinch, pinchOf({ x: 90, y: 100 }, { x: 210, y: 100 }));
  const b = pinchViewport(start, startPinch, pinchOf({ x: 100, y: 100 }, { x: 200, y: 100 }));
  assert.ok(a.zoom > 1);
  assert.deepEqual(b, start, "returning to the start spread restores the start viewport exactly");
});

test("pinchViewport clamps zoom and tolerates a zero start spread", () => {
  const start = { x: 0, y: 0, zoom: 3 };
  const wide = pinchViewport(start, pinchOf({ x: 0, y: 0 }, { x: 10, y: 0 }), pinchOf({ x: 0, y: 0 }, { x: 1000, y: 0 }));
  assert.equal(wide.zoom, MAX_ZOOM);
  const degenerate = pinchViewport(start, pinchOf({ x: 5, y: 5 }, { x: 5, y: 5 }), pinchOf({ x: 0, y: 0 }, { x: 10, y: 0 }));
  assert.equal(degenerate.zoom, 3, "no spread at the start means no zoom change");
});

test("doubleTapViewport zooms in by the double-tap factor around the tap", () => {
  const vp = { x: 40, y: -20, zoom: 1 };
  const tap = { x: 150, y: 250 };
  const anchor = screenToWorld(tap, vp);
  const next = doubleTapViewport(vp, tap);
  close(next.zoom, DOUBLE_TAP_ZOOM_FACTOR, "zoom factor");
  samePoint(screenToWorld(tap, next), anchor, "tap point fixed");
});

test("swipeZoomViewport zooms in when swiping up and out when swiping down", () => {
  const vp = { x: 0, y: 0, zoom: 1 };
  const anchor = { x: 200, y: 400 };
  const up = swipeZoomViewport(vp, anchor, -100);
  const down = swipeZoomViewport(vp, anchor, 100);
  assert.ok(up.zoom > 1, "swipe up zooms in");
  assert.ok(down.zoom < 1, "swipe down zooms out");
  close(up.zoom * down.zoom, 1, "symmetric");
  samePoint(screenToWorld(anchor, up), screenToWorld(anchor, vp), "anchor fixed on swipe up");
  assert.deepEqual(swipeZoomViewport(vp, anchor, 0), vp, "no travel, no change");
});

test("movedPastSlop ignores finger wobble but not a real drag", () => {
  const start = { x: 100, y: 100 };
  assert.equal(movedPastSlop(start, { x: 100 + TOUCH_SLOP_PX - 1, y: 100 }), false);
  assert.equal(movedPastSlop(start, { x: 100, y: 100 + TOUCH_SLOP_PX + 1 }), true);
  assert.equal(movedPastSlop(start, { x: 102, y: 100 }, 1), true, "custom slop");
});

test("isDoubleTap needs a recent, nearby previous tap", () => {
  const first = { point: { x: 100, y: 100 }, time: 1000 };
  assert.equal(isDoubleTap(null, { x: 100, y: 100 }, 1100), false);
  assert.equal(isDoubleTap(first, { x: 110, y: 90 }, 1000 + DOUBLE_TAP_MS), true);
  assert.equal(isDoubleTap(first, { x: 110, y: 90 }, 1000 + DOUBLE_TAP_MS + 1), false, "too slow");
  assert.equal(isDoubleTap(first, { x: 100 + DOUBLE_TAP_SLOP_PX + 1, y: 100 }, 1100), false, "too far");
});

test("isTap is a short press that never moved", () => {
  assert.equal(isTap(1000, 1000 + LONG_PRESS_MS - 1, false), true);
  assert.equal(isTap(1000, 1000 + LONG_PRESS_MS, false), false, "held long enough to be a long press");
  assert.equal(isTap(1000, 1050, true), false, "moved");
});

test("doubleTapAction: while viewing, text, stickies and shapes switch to editing; frames, images and empty board zoom", () => {
  const viewing = { viewOnly: true, readOnly: false };
  for (const type of ["text", "sticky", "rect", "ellipse", "triangle", "diamond"]) {
    assert.equal(doubleTapAction({ id: "n", type }, viewing), "edit", type);
  }
  assert.equal(doubleTapAction({ id: "n", type: "shape", shape: "star" }, viewing), "edit", "generic shape");
  assert.equal(doubleTapAction({ id: "n", type: "frame" }, viewing), "zoom", "frame");
  assert.equal(doubleTapAction({ id: "n", type: "image" }, viewing), "zoom", "image");
  assert.equal(doubleTapAction(null, viewing), "zoom", "empty board");
});

test("doubleTapAction: while editing, frames edit their label too and images and empty board still zoom", () => {
  const editing = { viewOnly: false, readOnly: false };
  for (const type of ["text", "sticky", "frame", "rect", "shape"]) {
    assert.equal(doubleTapAction({ id: "n", type }, editing), "edit", type);
  }
  assert.equal(doubleTapAction({ id: "n", type: "image" }, editing), "zoom", "image");
  assert.equal(doubleTapAction(null, editing), "zoom", "empty board");
});

test("doubleTapAction: a read-only board always zooms", () => {
  for (const viewOnly of [true, false]) {
    for (const type of ["text", "sticky", "frame", "shape", "image"]) {
      assert.equal(doubleTapAction({ id: "n", type }, { viewOnly, readOnly: true }), "zoom", `${type} viewOnly=${viewOnly}`);
    }
  }
});
