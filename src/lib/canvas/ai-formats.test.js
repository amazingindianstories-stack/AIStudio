import assert from "node:assert/strict";
import test from "node:test";
import { AI_FORMATS, AI_FORMAT_ORDER, STICKY_FILLS, imageNodes, inFreeSpace, placedCenter, screenRectToBoard, stickyColumns, stickyNodes,
  viewportShowing } from "./ai-formats.js";
import { validateCanvasState } from "./serialization.js";

const notes = (count) => ({ notes: Array.from({ length: count }, (_, index) => ({ text: `Idea ${index + 1}`, color: index % 2 ? "blue" : "magenta" })) });

test("sticky notes are laid out in reading order on a grid centred on the target", () => {
  assert.deepEqual([1, 3, 4, 5, 6, 9, 24].map(stickyColumns), [1, 3, 4, 3, 3, 4, 6]);
  const nodes = stickyNodes(notes(6), { x: 1000, y: 500 });
  assert.equal(nodes.length, 6);
  assert.deepEqual(nodes.map((node) => node.text), ["Idea 1", "Idea 2", "Idea 3", "Idea 4", "Idea 5", "Idea 6"]);
  // 3 columns x 2 rows of 200 px with 24 px gaps: 648 x 424, centred on (1000, 500).
  assert.deepEqual(nodes.map((node) => [node.x, node.y]), [[676, 288], [900, 288], [1124, 288], [676, 512], [900, 512], [1124, 512]]);
  assert.equal(new Set(nodes.map((node) => node.id)).size, 6);
  // Unknown colors fall back to yellow; known ones use the board palette.
  assert.deepEqual(nodes.slice(0, 2).map((node) => node.fill), [STICKY_FILLS.yellow, STICKY_FILLS.blue]);
  assert.deepEqual(stickyNodes({ notes: [] }, { x: 0, y: 0 }), []);
  assert.deepEqual(stickyNodes(null, { x: 0, y: 0 }), []);
});

test("generated nodes survive the board's own validation unchanged", () => {
  const nodes = [...stickyNodes(notes(3), { x: 0, y: 0 }), ...imageNodes({ url: "/api/media/generations/a/master.png", aspectRatio: "16:9" }, { x: 0, y: 0 }, "a lantern")];
  const state = validateCanvasState({ version: 1, viewport: { x: 0, y: 0, zoom: 1 }, nodes, connectors: [] });
  assert.equal(state.nodes.length, 4);
  for (const node of nodes) assert.deepEqual(state.nodes.find((entry) => entry.id === node.id), node);
});

test("an image result becomes one 320 px node, and only a stored media source is placed", () => {
  const [wide] = imageNodes({ url: "/api/media/x.png", aspectRatio: "16:9" }, { x: 100, y: 100 }, "prompt");
  assert.deepEqual([wide.w, wide.h, wide.x, wide.y, wide.src, wide.alt], [320, 180, -60, 10, "/api/media/x.png", "prompt"]);
  const [tall] = imageNodes({ url: "/api/media/y.png", aspectRatio: "9:16" }, { x: 0, y: 0 });
  assert.deepEqual([tall.w, tall.h], [180, 320]);
  assert.deepEqual(imageNodes({ url: "https://elsewhere.example/x.png" }, { x: 0, y: 0 }), []);
});

test("a refinement is placed where the result it replaces still is", () => {
  const nodes = [{ id: "a", x: 0, y: 0, w: 200, h: 200 }, { id: "b", x: 300, y: 100, w: 200, h: 200 }, { id: "c", x: 900, y: 900, w: 10, h: 10 }];
  assert.deepEqual(placedCenter(nodes, ["a", "b", "gone"]), { x: 250, y: 150 });
  assert.equal(placedCenter(nodes, ["gone"]), null);
  assert.equal(placedCenter(nodes, []), null);
});

test("every offered format has panel copy, suggestions and a node builder", () => {
  assert.deepEqual(AI_FORMAT_ORDER, ["stickies", "image"]);
  for (const id of AI_FORMAT_ORDER) {
    const format = AI_FORMATS[id];
    assert.equal(format.id, id);
    assert.ok(format.label && format.placeholder && format.refinePlaceholder);
    assert.ok(format.suggestions.length >= 3);
    assert.equal(typeof format.nodes, "function");
  }
  assert.equal(AI_FORMATS.stickies.resultLabel({ notes: [{}] }), "1 sticky note");
  assert.equal(AI_FORMATS.stickies.resultLabel(notes(4)), "4 sticky notes");
});

test("a new result goes to the free slot nearest the viewport centre, never on top of existing content", () => {
  const built = stickyNodes(notes(3), { x: 0, y: 0 });                        // 648 x 200 centred on (0, 0)
  assert.deepEqual(inFreeSpace(built, []), built);
  assert.deepEqual(inFreeSpace(built, [{ x: 2000, y: 2000, w: 10, h: 10 }]), built, "a clear centre keeps the centre");
  const blocked = [{ x: -100, y: -100, w: 200, h: 200 }];
  const moved = inFreeSpace(built, blocked);
  // The nearest free slot is one result-height (200 + 48) above or below; above wins the tie.
  assert.deepEqual(moved.map((node) => node.y), [-348, -348, -348]);
  assert.deepEqual(moved.map((node) => node.x), built.map((node) => node.x));
  const box = (nodes) => ({ x0: Math.min(...nodes.map((n) => n.x)), y1: Math.max(...nodes.map((n) => n.y + n.h)) });
  assert.ok(box(moved).y1 <= blocked[0].y, "no overlap");
});

test("a canvas-pixel rect maps to the board rect under the viewport", () => {
  assert.deepEqual(screenRectToBoard({ x: 100, y: 50, w: 200, h: 80 }, { x: 1000, y: -500, zoom: 2 }), { x: 1050, y: -475, w: 100, h: 40 });
});

test("the viewport pans (zooming out only when it must) when a placed result is not fully visible outside the panel", () => {
  const size = { x: 0, y: 0, w: 1600, h: 900 };
  const panel = { x: 520, y: 588, w: 560, h: 240 };
  const vp = { x: 0, y: 0, zoom: 1 };
  const at = (x, y) => [{ x, y, w: 424, h: 200 }];
  assert.equal(viewportShowing(at(100, 100), vp, size, panel), vp, "already in view: unchanged");
  assert.equal(viewportShowing([], vp, size, panel), vp);
  // Under the panel: centred in the band above it (1600 x 588), at the same zoom.
  assert.deepEqual(viewportShowing(at(588, 600), vp, size, panel), { x: 0, y: 406, zoom: 1 });
  // Off screen with no panel: centred on the canvas.
  assert.deepEqual(viewportShowing(at(3000, 0), { x: 0, y: 0, zoom: 0.5 }, size, null), { x: 1612, y: -800, zoom: 0.5 });
  // Too tall for the band above a tall panel: the largest band beside it that fits (the right one, 640 x 900).
  const tallPanel = { x: 400, y: 100, w: 560, h: 800 };
  const tall = [{ x: 5000, y: 0, w: 300, h: 600 }];
  assert.deepEqual(viewportShowing(tall, vp, size, tallPanel), { x: 5150 - (960 + 320), y: 300 - 450, zoom: 1 });
  // Larger than any clear band at this zoom: zoomed out just enough to fit the band above the panel, with a margin.
  const wide = [{ x: 0, y: 0, w: 2784 / 4, h: 200 }];
  const fitted = viewportShowing(wide, { x: 540, y: -800, zoom: 4 }, size, panel);
  assert.equal(fitted.zoom, (1600 - 48) / 696);
  const onScreen = { x: (0 - fitted.x) * fitted.zoom, y: (0 - fitted.y) * fitted.zoom, w: 696 * fitted.zoom, h: 200 * fitted.zoom };
  assert.ok(Math.abs(onScreen.x - 24) < 1e-9 && Math.abs(onScreen.x + onScreen.w - 1576) < 1e-9, "fills the band width less the margin");
  assert.ok(onScreen.y >= 0 && onScreen.y + onScreen.h <= panel.y, "above the panel");
  // A side panel covering the left 300 px narrows the visible area: a result under it is panned out.
  const besideAssets = { x: 300, y: 0, w: 1300, h: 900 };
  assert.deepEqual(viewportShowing(at(100, 100), vp, besideAssets, panel), { x: 312 - 950, y: 200 - 294, zoom: 1 });
  assert.equal(viewportShowing(at(400, 100), vp, besideAssets, panel), vp);
});
