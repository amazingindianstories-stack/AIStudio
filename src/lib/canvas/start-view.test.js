/**
 * Unit tests for src/lib/canvas/start-view.js: the first visit on a device
 * opens at the board's start view; later visits keep the saved viewport.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MAX_ZOOM } from "./geometry.js";
import { MAX_SEEN_BOARDS, hasSeenBoard, markBoardSeen, withStartView } from "./start-view.js";

function useStorage(t) {
  const values = new Map();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key) => (values.has(key) ? values.get(key) : null),
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  });
  return values;
}

const board = (startView) => ({
  nodes: [],
  edges: [],
  viewport: { x: 1, y: 2, zoom: 1 },
  ...(startView ? { settings: { startView } } : {}),
});

test("the first visit opens at the start view; later visits keep the saved view", (t) => {
  useStorage(t);
  const state = board({ x: 500, y: -200, zoom: 0.5 });
  const first = withStartView("b1", state);
  assert.deepEqual(first.viewport, { x: 500, y: -200, zoom: 0.5 });
  assert.equal(first.nodes, state.nodes, "only the viewport changes");
  assert.equal(hasSeenBoard("b1"), true);
  assert.equal(withStartView("b1", state), state);
});

test("no start view, or a restored local draft, keeps the viewport but records the visit", (t) => {
  useStorage(t);
  const plain = board(null);
  assert.equal(withStartView("b2", plain), plain);
  assert.equal(hasSeenBoard("b2"), true);
  const state = board({ x: 9, y: 9, zoom: 1 });
  assert.equal(withStartView("b3", state, { keepViewport: true }), state);
  assert.equal(withStartView("b3", state), state, "the draft visit counted as the first");
});

test("a start view zoom is clamped to the supported range", (t) => {
  useStorage(t);
  assert.equal(withStartView("b4", board({ x: 0, y: 0, zoom: 500 })).viewport.zoom, MAX_ZOOM);
});

test("the seen list keeps the most recent boards and tolerates bad storage", (t) => {
  const values = useStorage(t);
  for (let i = 0; i < MAX_SEEN_BOARDS + 5; i += 1) markBoardSeen(`board-${i}`);
  assert.equal(hasSeenBoard("board-0"), false, "the oldest drop out");
  assert.equal(hasSeenBoard(`board-${MAX_SEEN_BOARDS + 4}`), true);
  markBoardSeen("board-5");
  assert.equal(hasSeenBoard("board-5"), true, "a revisit moves to the end");
  values.set("veevee.board.seen", "{not json");
  assert.equal(hasSeenBoard("board-5"), false);
  markBoardSeen("x");
  assert.equal(hasSeenBoard("x"), true);
});

test("without storage every visit is a first visit", (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("blocked");
    },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  });
  const state = board({ x: 3, y: 4, zoom: 2 });
  assert.deepEqual(withStartView("b5", state).viewport, { x: 3, y: 4, zoom: 2 });
  assert.deepEqual(withStartView("b5", state).viewport, { x: 3, y: 4, zoom: 2 });
});
