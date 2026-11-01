import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { FramesPanel } from "./FramesPanel.jsx";
import { useCanvasStore } from "../../lib/canvas-store.js";
import { useBoardUi } from "../../lib/canvas/board-ui.js";
import { orderedFrames } from "../../lib/canvas/frames.js";
import { emptyCanvasState } from "../../lib/canvas/serialization.js";

function withDom(t) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  const names = ["window", "document", "HTMLElement", "React", "IS_REACT_ACT_ENVIRONMENT", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle", "ResizeObserver"];
  const prior = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, React,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    getComputedStyle: dom.window.getComputedStyle, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } });
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  t.after(() => Object.assign(globalThis, prior));
}

const frame = (id, x, extra = {}) => ({ id, type: "frame", name: id, x, y: 0, w: 200, h: 100, parentId: null, groupId: null, ...extra });

async function renderPanel(t, nodes) {
  withDom(t);
  const original = useCanvasStore.getState();
  const originalUi = useBoardUi.getState();
  useCanvasStore.setState({ boardId: "board-1", boardRole: "owner", accessLost: false, selection: [],
    history: { past: [], present: { ...emptyCanvasState(), nodes }, future: [] } });
  // react-dom/client decides at import whether native `input` events exist, so it loads after the DOM.
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("#root"));
  await act(async () => root.render(React.createElement(FramesPanel, { canEdit: true, onClose() {} })));
  t.after(async () => {
    await act(async () => root.unmount());
    useCanvasStore.getState().reset();
    useCanvasStore.setState(original, true);
    useBoardUi.setState(originalUi, true);
  });
}

const row = (name) => [...document.querySelectorAll("[data-testid=frame-row]")].find((el) => el.textContent.includes(name));
const order = () => orderedFrames(useCanvasStore.getState().history.present).map((f) => f.id);
const notice = () => useBoardUi.getState().notice.text;
const altArrow = (el, key) => act(async () => {
  el.dispatchEvent(new window.KeyboardEvent("keydown", { key, altKey: true, bubbles: true }));
});
function type(el, value) {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set.call(el, value);
  el.dispatchEvent(new window.Event("input", { bubbles: true }));
}

test("a locked frame row cannot be dragged or moved, and says why", async (t) => {
  await renderPanel(t, [frame("A", 0, { locked: true, frameOrder: 0 }), frame("B", 400, { frameOrder: 1 }), frame("C", 800, { frameOrder: 2 })]);
  assert.equal(row("A").draggable, false);
  assert.equal(row("B").draggable, true);
  await altArrow(row("A"), "ArrowDown");
  assert.deepEqual(order(), ["A", "B", "C"]);
  assert.equal(notice(), "Locked - unlock to edit");
});

test("moving a frame keeps a placed locked frame in its slot", async (t) => {
  await renderPanel(t, [frame("A", 0, { locked: true, frameOrder: 0 }), frame("B", 400, { frameOrder: 1 }), frame("C", 800, { frameOrder: 2 })]);
  await altArrow(row("C"), "ArrowUp");
  assert.deepEqual(order(), ["A", "C", "B"]);
  // B cannot pass the locked A.
  await altArrow(row("C"), "ArrowUp");
  assert.deepEqual(order(), ["A", "C", "B"]);
  assert.equal(notice(), "Locked - unlock to edit");
});

test("on a never-reordered board a move that would send the locked frame last is refused", async (t) => {
  await renderPanel(t, [frame("A", 0, { locked: true }), frame("B", 400), frame("C", 800)]);
  await altArrow(row("C"), "ArrowUp");
  assert.deepEqual(order(), ["A", "B", "C"]);
  assert.equal(notice(), "Locked - unlock to edit");
  assert.equal(useCanvasStore.getState().history.past.length, 0);
});

test("a locked frame's presenter notes are read-only and say why", async (t) => {
  await renderPanel(t, [frame("A", 0, { locked: true, notes: "Hello" }), frame("B", 400)]);
  await act(async () => row("A").click());
  assert.equal(document.querySelector("textarea#frame-notes"), null);
  assert.equal(document.querySelector("#frame-notes").textContent, "Hello");
  assert.ok(document.body.textContent.includes("Locked - unlock to edit"));
  await act(async () => row("B").click());
  assert.ok(document.querySelector("textarea#frame-notes"));
});

test("notes typed before someone locks the frame are reported as not saved", async (t) => {
  await renderPanel(t, [frame("A", 0), frame("B", 400)]);
  await act(async () => row("A").click());
  await act(async () => type(document.querySelector("textarea#frame-notes"), "Draft notes"));
  await act(async () => useCanvasStore.setState((s) => ({
    history: { ...s.history, present: { ...s.history.present, nodes: s.history.present.nodes.map((n) => (n.id === "A" ? { ...n, locked: true } : n)) } },
  })));
  assert.equal(document.querySelector("textarea#frame-notes"), null);
  // Picking another frame commits the draft, which the lock refuses.
  await act(async () => row("B").click());
  assert.equal(useCanvasStore.getState().history.present.nodes.find((n) => n.id === "A").notes, undefined);
  assert.equal(notice(), "Locked - presenter notes not saved");
});

test("organize leaves a locked frame in place and says so", async (t) => {
  await renderPanel(t, [frame("A", 3000, { locked: true, frameOrder: 0 }), frame("B", 0, { frameOrder: 1 }), frame("C", 900, { frameOrder: 2 })]);
  const button = [...document.querySelectorAll("button")].find((el) => el.textContent.includes("Organize frames"));
  await act(async () => button.click());
  const byId = Object.fromEntries(useCanvasStore.getState().history.present.nodes.map((n) => [n.id, n]));
  assert.equal(byId.A.x, 3000);
  assert.deepEqual([byId.B.x, byId.C.x], [0, 280]);
  assert.equal(notice(), "Frames organized; locked frames stayed in place");
});
