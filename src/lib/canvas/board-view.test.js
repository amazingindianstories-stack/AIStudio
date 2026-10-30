/**
 * Unit tests for src/lib/canvas/board-view.js: background palette, grid,
 * minimap and scroll bar maths, and the selection size label.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { GRID_SIZE } from "./view-prefs.js";
import {
  BOARD_BACKGROUNDS,
  DEFAULT_BOARD_BACKGROUND,
  MIN_THUMB_PX,
  boardBackgroundColor,
  centerViewportOn,
  fromMinimap,
  gridBackground,
  gridSpacing,
  minimapTransform,
  navigationExtent,
  nextGridStyle,
  scrollThumb,
  selectionSize,
  surfaceBackground,
  toMinimap,
  viewRect,
} from "./board-view.js";

const close = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-6, `${message}: ${a} vs ${b}`);

test("the background palette has eleven distinct colors with the default first", () => {
  assert.equal(BOARD_BACKGROUNDS.length, 11);
  assert.deepEqual(BOARD_BACKGROUNDS[0], { value: null, color: DEFAULT_BOARD_BACKGROUND, name: "Default" });
  assert.equal(new Set(BOARD_BACKGROUNDS.map((c) => c.color)).size, 11);
  assert.equal(new Set(BOARD_BACKGROUNDS.map((c) => c.name)).size, 11);
  for (const choice of BOARD_BACKGROUNDS.slice(1)) assert.match(choice.value, /^#[0-9a-f]{6}$/);
});

test("the background color falls back to the default for missing or malformed values", () => {
  assert.equal(boardBackgroundColor(undefined), DEFAULT_BOARD_BACKGROUND);
  assert.equal(boardBackgroundColor({}), DEFAULT_BOARD_BACKGROUND);
  assert.equal(boardBackgroundColor({ background: "red" }), DEFAULT_BOARD_BACKGROUND);
  assert.equal(boardBackgroundColor({ background: "url(x)" }), DEFAULT_BOARD_BACKGROUND);
  assert.equal(boardBackgroundColor({ background: "#121a2e" }), "#121a2e");
});

test("the grid scales with zoom and coarsens instead of turning to noise", () => {
  assert.equal(gridSpacing(1), GRID_SIZE);
  assert.equal(gridSpacing(2), GRID_SIZE * 2);
  assert.equal(gridSpacing(20), GRID_SIZE * 20);
  assert.ok(gridSpacing(0.1) >= 8, "never denser than 8px");
  close(gridSpacing(0.25), GRID_SIZE * 0.25 * 4, "a quarter zoom shows every 4th line");
});

test("grid backgrounds: dots, lines and none, fixed to the world", () => {
  const vp = { x: 10, y: -5, zoom: 2 };
  const dots = gridBackground("dots", vp);
  assert.match(dots.backgroundImage, /^radial-gradient/);
  assert.equal(dots.backgroundSize, `${GRID_SIZE * 2}px ${GRID_SIZE * 2}px`);
  assert.equal(dots.backgroundPosition, "-20px 10px");
  const lines = gridBackground("lines", vp);
  assert.equal((lines.backgroundImage.match(/linear-gradient/g) ?? []).length, 2);
  assert.equal(lines.backgroundPosition, "-20px 10px, -20px 10px");
  assert.deepEqual(gridBackground("none", vp), {});
  assert.deepEqual(gridBackground(undefined, vp), {});
});

test("the board surface paints the board color under the grid", () => {
  const vp = { x: 0, y: 0, zoom: 1 };
  assert.deepEqual(surfaceBackground("none", vp, { background: "#13251c" }), { backgroundColor: "#13251c" });
  const withDots = surfaceBackground("dots", vp, undefined);
  assert.equal(withDots.backgroundColor, DEFAULT_BOARD_BACKGROUND);
  assert.match(withDots.backgroundImage, /radial-gradient/);
});

test("G cycles dots, lines, none", () => {
  assert.equal(nextGridStyle("dots"), "lines");
  assert.equal(nextGridStyle("lines"), "none");
  assert.equal(nextGridStyle("none"), "dots");
  assert.equal(nextGridStyle("bogus"), "dots");
});

test("the navigation extent always includes the view", () => {
  const view = viewRect({ x: 1000, y: 1000, zoom: 2 }, { w: 800, h: 600 });
  assert.deepEqual(view, { x: 1000, y: 1000, w: 400, h: 300 });
  assert.deepEqual(navigationExtent(null, view), view, "an empty board spans the view");
  const extent = navigationExtent({ x: 0, y: 0, w: 100, h: 100 }, view, 50);
  assert.deepEqual(extent, { x: -50, y: -50, w: 1450, h: 1350 });
});

test("minimap mapping fits the extent, centres it, and round-trips", () => {
  const extent = { x: -100, y: 0, w: 1000, h: 200 };
  const t = minimapTransform(extent, 200, 128);
  close(t.scale, 0.2, "width-bound scale");
  close(t.offsetX, 0, "no horizontal margin");
  close(t.offsetY, (128 - 40) / 2, "centred vertically");
  const box = toMinimap(t, { x: 400, y: 100, w: 50, h: 20 });
  assert.deepEqual(box, { x: 100, y: t.offsetY + 20, w: 10, h: 4 });
  const world = fromMinimap(t, { x: box.x, y: box.y });
  close(world.x, 400, "x round trip");
  close(world.y, 100, "y round trip");
  const inset = minimapTransform(extent, 200, 128, 10);
  close(inset.scale, 0.18, "inset shrinks the fit");
  close(inset.offsetX, 10, "inset keeps the edges clear");
  const back = fromMinimap(inset, toMinimap(inset, { x: 400, y: 100, w: 0, h: 0 }));
  close(back.x, 400, "inset round trip");
});

test("centring the view keeps the zoom", () => {
  assert.deepEqual(centerViewportOn({ x: 0, y: 0, zoom: 2 }, { x: 500, y: 300 }, { w: 800, h: 600 }), { x: 300, y: 150, zoom: 2 });
});

test("scroll thumbs size to the view and travel the track", () => {
  const atStart = scrollThumb(0, 1000, 0, 250, 400);
  assert.deepEqual(atStart, { offset: 0, length: 100, ratio: 750 / 300 });
  const atEnd = scrollThumb(0, 1000, 750, 250, 400);
  assert.equal(atEnd.offset, 300);
  const middle = scrollThumb(0, 1000, 375, 250, 400);
  assert.equal(middle.offset, 150);
  const tiny = scrollThumb(0, 1e6, 0, 10, 400);
  assert.equal(tiny.length, MIN_THUMB_PX, "a minimum grab size");
  const all = scrollThumb(0, 100, 0, 100, 400);
  assert.equal(all.length, 400, "the whole board in view fills the track");
  assert.equal(all.ratio, 0);
});

test("the size label shows one node's own size or the selection box", () => {
  const boundsOf = (n) => ({ x: n.x, y: n.y, w: n.w, h: n.h });
  assert.equal(selectionSize([], boundsOf), null);
  assert.deepEqual(selectionSize([{ x: 0, y: 0, w: 120.4, h: 79.6 }], boundsOf), {
    box: { x: 0, y: 0, w: 120.4, h: 79.6 },
    w: 120,
    h: 80,
  });
  // A rotated node keeps its own w x h; the box is its rotated bounds.
  const rotated = selectionSize([{ x: 0, y: 0, w: 200, h: 100 }], () => ({ x: 50, y: -50, w: 100, h: 200 }));
  assert.equal(rotated.w, 200);
  assert.equal(rotated.h, 100);
  const many = selectionSize(
    [
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 300, y: 50, w: 100, h: 150 },
    ],
    boundsOf
  );
  assert.deepEqual([many.w, many.h], [400, 200]);
});
