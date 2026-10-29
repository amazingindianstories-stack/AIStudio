/**
 * Pure touch-gesture maths for the board canvas: pinch zoom, double-tap zoom,
 * tap and long-press recognition. No DOM; CanvasSurface feeds it screen-local
 * pointer positions and applies the viewports it returns.
 *
 * Screen points are container-local pixels. A viewport is `{x, y, zoom}` where
 * `(x, y)` is the world point shown at the container's top-left corner.
 */
import { clampZoom, screenToWorld } from "./geometry.js";
import { isShapeNode } from "./shapes.js";

/** Fingers wobble; a touch counts as moved only past this many pixels. */
export const TOUCH_SLOP_PX = 8;
/** Second tap must land within this time and distance of the first. */
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_SLOP_PX = 24;
/** A tap longer than this (without moving) becomes a long press. */
export const LONG_PRESS_MS = 450;
/** A plain double tap zooms in by this factor around the tap point. */
export const DOUBLE_TAP_ZOOM_FACTOR = 2;
/** Double tap and swipe: zoom factor per pixel of vertical travel (up zooms in). */
export const SWIPE_ZOOM_PER_PX = 0.008;

export function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Viewport at `nextZoom` that keeps the world point currently under `screen`
 * fixed under that same screen point. Shared by pinch, double tap and swipe.
 */
export function zoomAroundPoint(viewport, screen, nextZoom) {
  const zoom = clampZoom(nextZoom);
  const world = screenToWorld(screen, viewport);
  return { zoom, x: world.x - screen.x / zoom, y: world.y - screen.y / zoom };
}

/** Centre and finger spread of a two-finger touch. */
export function pinchOf(a, b) {
  return { center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, distance: distance(a, b) };
}

/**
 * Viewport for a pinch that started at `startPinch` on `startViewport` and is
 * now at `pinch`. Zoom scales with finger spread and the world point that was
 * under the pinch centre follows the centre, so moving both fingers pans.
 * Computed from the gesture start every time, so no rounding accumulates.
 */
export function pinchViewport(startViewport, startPinch, pinch) {
  const ratio = startPinch.distance > 0 ? pinch.distance / startPinch.distance : 1;
  const zoom = clampZoom(startViewport.zoom * ratio);
  const anchor = screenToWorld(startPinch.center, startViewport);
  return { zoom, x: anchor.x - pinch.center.x / zoom, y: anchor.y - pinch.center.y / zoom };
}

/** A plain double tap: zoom in around the tapped point. */
export function doubleTapViewport(viewport, screen) {
  return zoomAroundPoint(viewport, screen, viewport.zoom * DOUBLE_TAP_ZOOM_FACTOR);
}

/**
 * Double tap and swipe: the second tap stays down and slides. Swiping up
 * (negative dy) zooms in, down zooms out, around where the finger landed.
 */
export function swipeZoomViewport(startViewport, anchor, dy) {
  return zoomAroundPoint(startViewport, anchor, startViewport.zoom * Math.exp(-dy * SWIPE_ZOOM_PER_PX));
}

/** True when a touch that went down at `start` and is now at `point` has moved past the slop. */
export function movedPastSlop(start, point, slop = TOUCH_SLOP_PX) {
  return distance(start, point) > slop;
}

/**
 * True when a touch going down at `point` at time `now` completes a double tap
 * with `lastTap` (`{point, time}` of the previous completed tap, or null).
 */
export function isDoubleTap(lastTap, point, now) {
  if (!lastTap) return false;
  return now - lastTap.time <= DOUBLE_TAP_MS && distance(lastTap.point, point) <= DOUBLE_TAP_SLOP_PX;
}

/** True when a touch that went down at `downTime` and never moved past the slop lifts at `upTime` as a tap. */
export function isTap(downTime, upTime, moved) {
  return !moved && upTime - downTime < LONG_PRESS_MS;
}

/**
 * What a touch double tap on `node` (null for empty board) does: "edit" opens
 * the node's text for typing, "zoom" zooms in around the tap. While viewing,
 * text, stickies and shapes switch to editing; frames and images keep zooming
 * so large areas stay easy to zoom into. While editing, a frame edits its
 * label as well. A read-only board always zooms.
 */
export function doubleTapAction(node, { viewOnly, readOnly }) {
  if (!node || readOnly) return "zoom";
  if (node.type === "text" || node.type === "sticky" || isShapeNode(node)) return "edit";
  return node.type === "frame" && !viewOnly ? "edit" : "zoom";
}
