import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { BoardSwitcher } from "./BoardSwitcher.jsx";
import { CanvasView } from "./CanvasView.jsx";
import { useStore } from "../../lib/store.js";
import { useCanvasStore } from "../../lib/canvas-store.js";

const BOARD = { id: "board-1", projectId: "project", name: "Storyboard", createdBy: "me", createdAt: 1, updatedAt: 1, teamRole: "edit", role: "owner" };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function harness(server, run) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  const names = ["window", "document", "HTMLElement", "Node", "React", "IS_REACT_ACT_ENVIRONMENT", "fetch", "ResizeObserver", "IntersectionObserver",
    "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle", "MutationObserver", "localStorage"];
  const prior = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  const observer = class { observe() {} unobserve() {} disconnect() {} };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, React,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    MutationObserver: dom.window.MutationObserver, localStorage: dom.window.localStorage, ResizeObserver: observer, IntersectionObserver: observer,
    getComputedStyle: dom.window.getComputedStyle });
  dom.window.matchMedia = () => ({ matches: true, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    return server(call) ?? json(200, {});
  };
  const root = createRoot(document.querySelector("#root"));
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  try {
    await run({ root, calls, settle });
  } finally {
    await act(async () => root.unmount());
    useCanvasStore.getState().reset();
    Object.assign(globalThis, prior);
    dom.window.close();
  }
}

function renderSwitcher(root, props) {
  return act(async () => root.render(React.createElement(BoardSwitcher, { projectId: "project", boardId: null, ...props })));
}

const creates = (calls) => calls.filter((call) => call.body?.op === "createBoard");
const text = () => document.body.textContent;
const menuItem = (label) => [...document.querySelectorAll("[role=menuitem]")].find((item) => item.textContent.trim() === label);

async function openMenu(settle) {
  await act(async () => document.querySelector("button[aria-haspopup=menu]").click());
  await settle();
}

test("an empty project the caller cannot add to reports the empty state instead of creating or failing", async () => {
  await harness(({ url }) => url.startsWith("/api/canvas-boards?") ? json(200, { boards: [], canCreate: false }) : null, async ({ root, calls, settle }) => {
    const boardIds = [];
    const empty = [];
    await renderSwitcher(root, { onBoardIdChange: (id) => boardIds.push(id), onEmptyChange: (value) => empty.push(value) });
    await settle();
    assert.deepEqual(creates(calls), []);
    assert.deepEqual(boardIds, [null]);
    assert.equal(empty.at(-1), true);
    assert.match(text(), /No boards/);
    assert.doesNotMatch(text(), /Could not load boards/);
  });
});

test("an empty project the caller may add to still gets its first board created automatically", async () => {
  const server = ({ url, method }) => {
    if (url.startsWith("/api/canvas-boards?")) return json(200, { boards: [], canCreate: true });
    if (method === "POST") return json(200, { boards: [BOARD], board: BOARD, canCreate: true });
    return null;
  };
  await harness(server, async ({ root, calls, settle }) => {
    const boardIds = [];
    const empty = [];
    await renderSwitcher(root, { onBoardIdChange: (id) => boardIds.push(id), onEmptyChange: (value) => empty.push(value) });
    await settle();
    assert.equal(creates(calls).length, 1);
    assert.deepEqual(boardIds, [BOARD.id]);
    assert.ok(!empty.includes(true));
  });
});

test("a board chosen while the list loads (a followed link) is kept, not replaced by the first board", async () => {
  const second = { ...BOARD, id: "board-2", name: "Linked" };
  let release;
  const listed = new Promise((resolve) => { release = resolve; });
  const server = ({ url }) => url.startsWith("/api/canvas-boards?") ? listed.then(() => json(200, { boards: [BOARD, second], canCreate: true })) : null;
  await harness(server, async ({ root, settle }) => {
    const boardIds = [];
    const onBoardIdChange = (id) => boardIds.push(id);
    await renderSwitcher(root, { onBoardIdChange });
    await renderSwitcher(root, { boardId: second.id, onBoardIdChange });
    release();
    await settle();
    assert.deepEqual(boardIds, []);
  });
});

test("New board is offered only to callers who may create boards", async () => {
  for (const canCreate of [true, false]) {
    await harness(({ url }) => url.startsWith("/api/canvas-boards?") ? json(200, { boards: [BOARD], canCreate }) : null, async ({ root, settle }) => {
      await renderSwitcher(root, { boardId: BOARD.id, onBoardIdChange() {} });
      await settle();
      await openMenu(settle);
      assert.ok(menuItem("Storyboard"));
      assert.equal(Boolean(menuItem("New board")), canCreate, `canCreate=${canCreate}`);
    });
  }
});

test("a refused New board shows why and stops offering it", async () => {
  const server = ({ url, method }) => {
    if (url.startsWith("/api/canvas-boards?")) return json(200, { boards: [BOARD], canCreate: true });
    if (method === "POST") return json(403, { error: "FORBIDDEN" });
    return null;
  };
  await harness(server, async ({ root, calls, settle }) => {
    const boardIds = [];
    await renderSwitcher(root, { boardId: BOARD.id, onBoardIdChange: (id) => boardIds.push(id) });
    await settle();
    await openMenu(settle);
    await act(async () => menuItem("New board").click());
    await settle();
    assert.equal(creates(calls).length, 1);
    assert.deepEqual(boardIds, []);
    const notice = [...document.querySelectorAll("[role=status]")].find((element) => /Only project editors can add boards/.test(element.textContent));
    assert.ok(notice, "the refusal is visible");
    await openMenu(settle);
    assert.equal(menuItem("New board"), undefined);
  });
});

test("deleting the last board of a project the caller cannot add to ends in the empty state, not a new board", async () => {
  let deleted = false;
  const server = ({ url, body }) => {
    if (url.startsWith("/api/canvas-boards?")) return json(200, { boards: deleted ? [] : [BOARD], canCreate: false });
    if (body?.op === "deleteBoard") {
      deleted = true;
      return json(200, { boards: [], canCreate: false });
    }
    return null;
  };
  await harness(server, async ({ root, calls, settle }) => {
    const boardIds = [];
    const empty = [];
    const props = { boardId: BOARD.id, onBoardIdChange: (id) => boardIds.push(id), onEmptyChange: (value) => empty.push(value) };
    await renderSwitcher(root, props);
    await settle();
    await openMenu(settle);
    await act(async () => document.querySelector("[role=menu] button[aria-haspopup=menu]").click());
    await settle();
    await act(async () => menuItem("Delete").click());
    await settle();
    const confirm = [...document.querySelectorAll("[role=alertdialog] button")].find((button) => button.textContent === "Delete");
    await act(async () => confirm.click());
    await settle();
    await settle();
    assert.equal(deleted, true);
    assert.deepEqual(creates(calls), []);
    assert.equal(boardIds.at(-1), null);
    assert.equal(empty.at(-1), true);
    assert.match(text(), /No boards/);
  });
});

test("the canvas shows one empty state with tools, sharing and editing off when there is no board to open", async () => {
  await harness(({ url }) => {
    if (url.startsWith("/api/canvas-boards?")) return json(200, { boards: [], canCreate: false });
    if (url.startsWith("/api/assets")) return json(200, { assets: [], items: [] });
    return null;
  }, async ({ root, calls, settle }) => {
    const original = useStore.getState();
    useStore.setState({ activeProjectId: "project", projects: [{ id: "project", name: "Project" }], items: [], assets: [], currentUser: { id: "me", role: "user" } });
    try {
      await act(async () => root.render(React.createElement(CanvasView)));
      await settle();
      await settle();
      assert.deepEqual(creates(calls), []);
      const states = [...document.querySelectorAll("[role=status]")].filter((element) => /Only project editors can add boards to this project/.test(element.textContent));
      assert.equal(states.length, 1, "exactly one empty-state message");
      assert.equal(document.querySelector("[aria-label='Board tools']"), null, "the toolbar is hidden");
      assert.equal([...document.querySelectorAll("button")].some((button) => button.textContent.trim() === "Share"), false);
      assert.doesNotMatch(text(), /Unsaved|Saving|View only/);
      await act(async () => {
        useCanvasStore.getState().addNode({ id: "n1", type: "sticky", x: 0, y: 0, w: 10, h: 10 });
        useCanvasStore.getState().setViewport({ x: 5, y: 5, zoom: 2 });
      });
      assert.equal(useCanvasStore.getState().history.present.nodes.length, 0, "no edits without a board");
      assert.notEqual(useCanvasStore.getState().saveStatus, "dirty");
    } finally {
      await act(async () => useStore.setState(original, true));
    }
  });
});
