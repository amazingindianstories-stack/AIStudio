import assert from "node:assert/strict";
import test from "node:test";
import { createMarqueeController } from "./use-marquee-selection.js";

// Four 100x100 cards in a row, 10px apart, in a 400x300 scroller at the origin.
const CARDS = [0, 1, 2, 3].map((i) => ({ id: `c${i}`, x: i * 110, y: 0, w: 100, h: 100 }));

function setup({ selected = [], cards = CARDS } = {}) {
  const el = {
    scrollTop: 0,
    scrollLeft: 0,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 400, bottom: 300 }),
    querySelectorAll: () => cards.map((c) => ({
      getAttribute: () => c.id,
      getBoundingClientRect: () => ({ left: c.x, top: c.y, width: c.w, height: c.h }),
    })),
    setPointerCapture() {},
    releasePointerCapture() {},
  };
  const log = { selections: [], clicks: 0, active: [], rects: [] };
  let queue = [];
  let nextFrame = 1;
  const controller = createMarqueeController({
    getScroller: () => el,
    itemAttribute: "data-card",
    getSelected: () => selected,
    setSelected: (ids) => log.selections.push(ids),
    onClickBackground: () => { log.clicks += 1; },
    onActiveChange: (value) => log.active.push(value),
    onRect: (rect) => log.rects.push(rect),
    requestFrame: (fn) => { const id = nextFrame++; queue.push([id, fn]); return id; },
    cancelFrame: (id) => { queue = queue.filter(([queued]) => queued !== id); },
  });
  const flush = () => { const run = queue; queue = []; for (const [, fn] of run) fn(); };
  const background = { closest: () => null };
  const down = (x, y, extra = {}) => controller.pointerDown({ button: 0, pointerId: 1, pointerType: "mouse", clientX: x, clientY: y, target: background, ...extra });
  const move = (x, y, extra = {}) => controller.pointerMove({ clientX: x, clientY: y, shiftKey: false, altKey: false, ...extra });
  const up = (extra = {}) => controller.pointerUp({ shiftKey: false, metaKey: false, ctrlKey: false, ...extra });
  return { el, log, flush, controller, down, move, up, queued: () => queue.length, background };
}

test("a drag selects the cards under the rectangle and ignores the slop", () => {
  const t = setup();
  t.down(5, 150);
  t.move(7, 148);
  assert.deepEqual(t.log.active, [], "a movement inside the slop is still a click");
  t.move(230, 50);
  assert.deepEqual(t.log.active, [true]);
  assert.deepEqual(t.log.selections.at(-1), ["c0", "c1", "c2"]);
  t.up();
  assert.deepEqual(t.log.active, [true, false]);
  assert.equal(t.log.clicks, 0);
});

test("moves coalesce into one frame and the selection is written only when the hit set changes", () => {
  const t = setup();
  t.down(5, 150);
  t.move(50, 50); // first move computes at once so the overlay has a size
  const afterFirst = t.log.selections.length;
  for (let x = 60; x < 100; x += 5) t.move(x, 50);
  assert.equal(t.queued(), 1, "ten moves, one pending frame");
  t.flush();
  assert.equal(t.log.rects.length, 2, "the rectangle is positioned once per frame");
  assert.equal(t.log.selections.length, afterFirst + 0, "same cards hit, nothing written");
  t.move(130, 50);
  t.flush();
  assert.deepEqual(t.log.selections.at(-1), ["c0", "c1"]);
  t.move(131, 50);
  t.flush();
  assert.equal(t.log.selections.length, afterFirst + 1, "a move that hits the same cards writes nothing");
});

test("shift adds to the initial selection and alt removes from it", () => {
  const added = setup({ selected: ["c3"] });
  added.down(5, 150, { shiftKey: true });
  added.move(120, 50, { shiftKey: true });
  assert.deepEqual(added.log.selections.at(-1), ["c3", "c0", "c1"]);
  const removed = setup({ selected: ["c0", "c1", "c2"] });
  removed.down(5, 150, { altKey: true });
  removed.move(120, 50, { altKey: true });
  assert.deepEqual(removed.log.selections.at(-1), ["c2"]);
});

test("releasing applies a pointer position that was still waiting for its frame", () => {
  const t = setup();
  t.down(5, 150);
  t.move(50, 50);
  t.move(230, 50);
  assert.deepEqual(t.log.selections.at(-1), ["c0"]);
  t.up();
  assert.deepEqual(t.log.selections.at(-1), ["c0", "c1", "c2"]);
  assert.equal(t.queued(), 0);
});

test("a click on empty background clears, a modified click does not", () => {
  const t = setup();
  t.down(5, 150);
  t.up();
  assert.equal(t.log.clicks, 1);
  t.down(5, 150);
  t.up({ shiftKey: true });
  assert.equal(t.log.clicks, 1);
});

test("a drag that starts on a card, a control, a touch or another button is not a marquee", () => {
  const t = setup();
  t.down(5, 5, { target: { closest: (selector) => (selector.includes("data-card") ? {} : null) } });
  t.move(200, 200);
  t.down(5, 5, { target: { closest: (selector) => (selector.includes("button") ? {} : null) } });
  t.move(200, 200);
  t.down(5, 5, { pointerType: "touch" });
  t.move(200, 200);
  t.down(5, 5, { button: 2 });
  t.move(200, 200);
  assert.deepEqual(t.log.active, []);
  assert.deepEqual(t.log.selections, []);
});

test("holding the pointer near the bottom edge keeps scrolling and extends the selection", () => {
  const cards = [
    { id: "top", x: 0, y: 0, w: 100, h: 100 },
    { id: "low", x: 0, y: 400, w: 100, h: 100 },
  ];
  const t = setup({ cards });
  t.down(5, 5);
  t.move(50, 290);
  assert.ok(t.el.scrollTop > 0, "autoscroll started with the first frame");
  const first = t.el.scrollTop;
  assert.equal(t.queued(), 1, "another frame is requested while in the edge band");
  for (let i = 0; i < 8; i += 1) t.flush();
  assert.ok(t.el.scrollTop > first);
  assert.deepEqual(t.log.selections.at(-1), ["top", "low"]);
  t.up();
  assert.equal(t.queued(), 0);
});

test("a cancelled pointer ends the drag without clearing", () => {
  const t = setup();
  t.down(5, 150);
  t.move(80, 50);
  t.controller.pointerCancel();
  assert.deepEqual(t.log.active, [true, false]);
  assert.equal(t.log.clicks, 0);
  t.move(90, 50);
  assert.equal(t.queued(), 0);
});

test("a touch tap on the background clears the selection but a touch drag does not start a marquee", () => {
  const tap = setup({ selected: ["c1"] });
  tap.down(5, 150, { pointerType: "touch" });
  tap.up();
  assert.equal(tap.log.clicks, 1);
  assert.deepEqual(tap.log.active, []);

  const drag = setup({ selected: ["c1"] });
  drag.down(5, 150, { pointerType: "touch" });
  drag.move(230, 50);
  drag.up();
  assert.equal(drag.log.clicks, 0, "a scroll gesture is not a tap");
  assert.deepEqual(drag.log.active, []);
  assert.deepEqual(drag.log.selections, []);

  const onCard = setup();
  onCard.down(5, 5, { pointerType: "touch", target: { closest: () => ({}) } });
  onCard.up();
  assert.equal(onCard.log.clicks, 0);
});
