/**
 * Pure viewport navigation maths: what a wheel or trackpad event does under
 * each navigation mode, and the zoom steps used by the keyboard and the zoom
 * control. No DOM; the surface hands in plain event fields.
 */
import { zoomAroundPoint } from "./touch-gestures";

// One zoom-in step (keyboard, zoom buttons); zoom out divides by it.
export const ZOOM_STEP = 1.2;
// Wheel zoom speed per pixel of delta, and the largest delta one event may
// apply, so a mouse notch (about 100px) zooms a comfortable step while a
// trackpad pinch (a stream of small deltas) stays smooth.
export const WHEEL_ZOOM_SPEED = 0.01;
export const WHEEL_ZOOM_MAX_DELTA = 24;
const LINE_PX = 16;

export const NAVIGATION_MODES = ["auto", "mouse", "trackpad"];

/** Event deltas in pixels, whatever unit the browser reported them in. */
export function wheelDeltaPx(event, pageHeight = 800) {
  const unit = event.deltaMode === 1 ? LINE_PX : event.deltaMode === 2 ? pageHeight : 1;
  return { dx: (event.deltaX || 0) * unit, dy: (event.deltaY || 0) * unit };
}

/**
 * Best guess whether a plain wheel event came from a notched mouse wheel
 * rather than a trackpad. Line or page deltas only come from wheels; Chrome
 * and Safari report trackpad scrolls with `wheelDeltaY === -3 * deltaY`, while
 * a wheel notch is a multiple of 120 there; a sideways delta is a trackpad.
 */
export function looksLikeMouseWheel(event) {
  if (event.deltaMode === 1 || event.deltaMode === 2) return true;
  if (event.deltaX) return false;
  const legacy = event.wheelDeltaY;
  if (typeof legacy !== "number" || legacy === 0) return false;
  if (legacy === -3 * event.deltaY) return false;
  return Math.abs(legacy) % 120 === 0;
}

/**
 * What a wheel event does: `{ type: "zoom", delta }` (positive zooms out) or
 * `{ type: "pan", dx, dy }` in screen pixels. Cmd/Ctrl + wheel (and a
 * trackpad pinch, which browsers send as Ctrl + wheel) always zooms.
 * - "mouse": the wheel zooms about the cursor; Shift + wheel pans sideways.
 * - "trackpad": two-finger scroll pans in both directions.
 * - "auto": a wheel that looks like a notched mouse wheel zooms, anything
 *   else pans as on a trackpad.
 */
export function wheelIntent(event, mode = "auto", pageHeight = 800) {
  const { dx, dy } = wheelDeltaPx(event, pageHeight);
  if (event.ctrlKey || event.metaKey) return { type: "zoom", delta: dy || dx };
  const mouse = mode === "mouse" || (mode === "auto" && looksLikeMouseWheel(event));
  if (!mouse) return { type: "pan", dx, dy };
  if (event.shiftKey) return { type: "pan", dx: dx || dy, dy: 0 };
  // A tilt wheel (or a sideways trackpad scroll in mouse mode) still pans sideways.
  if (!dy) return { type: "pan", dx, dy: 0 };
  return { type: "zoom", delta: dy };
}

/** The zoom factor for a wheel zoom delta (pixels; positive zooms out). */
export function wheelZoomFactor(delta) {
  const capped = Math.max(-WHEEL_ZOOM_MAX_DELTA, Math.min(WHEEL_ZOOM_MAX_DELTA, delta));
  return Math.exp(-capped * WHEEL_ZOOM_SPEED);
}

/** The viewport after a wheel event at `point` (screen pixels within the board). */
export function wheelViewport(viewport, point, event, mode = "auto", pageHeight = 800) {
  const intent = wheelIntent(event, mode, pageHeight);
  if (intent.type === "zoom") {
    if (!intent.delta) return viewport;
    return zoomAroundPoint(viewport, point, viewport.zoom * wheelZoomFactor(intent.delta));
  }
  if (!intent.dx && !intent.dy) return viewport;
  return { ...viewport, x: viewport.x + intent.dx / viewport.zoom, y: viewport.y + intent.dy / viewport.zoom };
}

/** Zooms by `factor` about the centre of a `size` ({w, h}) board, clamped to the zoom range. */
export function zoomAboutCenter(viewport, factor, size) {
  return zoomAroundPoint(viewport, { x: size.w / 2, y: size.h / 2 }, viewport.zoom * factor);
}

/** Sets an exact zoom level about the board centre. */
export function zoomToLevel(viewport, zoom, size) {
  return zoomAroundPoint(viewport, { x: size.w / 2, y: size.h / 2 }, zoom);
}

/**
 * 1 for a Cmd/Ctrl + plus (also "=" and the numpad plus), -1 for Cmd/Ctrl +
 * minus (and the numpad minus), otherwise 0.
 */
export function keyboardZoomDirection(event) {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return 0;
  if (event.key === "+" || event.key === "=" || event.code === "Equal" || event.code === "NumpadAdd") return 1;
  if (event.key === "-" || event.key === "_" || event.code === "Minus" || event.code === "NumpadSubtract") return -1;
  return 0;
}
