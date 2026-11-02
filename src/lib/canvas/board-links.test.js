import assert from "node:assert/strict";
import test from "node:test";
import { watchBoardLinks } from "./board-links.js";
import { useStore } from "../store.js";

function fakeWindow(href) {
  const listeners = new Set();
  const win = {
    location: { href },
    history: { replaceState: (_state, _title, url) => (win.location.href = String(url)) },
    navigator: {
      serviceWorker: {
        addEventListener: (type, listener) => type === "message" && listeners.add(listener),
        removeEventListener: (type, listener) => type === "message" && listeners.delete(listener),
      },
    },
    post: (data) => [...listeners].forEach((listener) => listener({ data })),
    listeners,
  };
  return win;
}

test("a notification link opens its board once and leaves the address clean", () => {
  const win = fakeWindow("https://veevee.test/?board=b1&project=p1&comment=c1&keep=1");
  const opened = [];
  const stop = watchBoardLinks(win, (link) => opened.push(link));
  assert.deepEqual(opened, [{ boardId: "b1", projectId: "p1", commentId: "c1" }]);
  assert.equal(win.location.href, "https://veevee.test/?keep=1");
  stop();
  watchBoardLinks(win, (link) => opened.push(link))();
  assert.equal(opened.length, 1);
});

test("service worker notification clicks open their board until unsubscribed", () => {
  const win = fakeWindow("https://veevee.test/");
  const opened = [];
  const stop = watchBoardLinks(win, (link) => opened.push(link));
  assert.deepEqual(opened, []);
  win.post({ type: "something-else", boardId: "x" });
  win.post({ type: "open-board", boardId: "b2", projectId: "p2", commentId: null });
  assert.deepEqual(opened.map((link) => link.boardId), ["b2"]);
  stop();
  assert.equal(win.listeners.size, 0);
});

test("opening a board link from the Studio view switches to the Board view and keeps the target", () => {
  const previous = useStore.getState();
  try {
    useStore.setState({ view: "studio", boardLink: null });
    useStore.getState().openBoardLink({ type: "open-board", boardId: "b3", projectId: "p3" });
    assert.equal(useStore.getState().view, "canvas");
    assert.deepEqual(useStore.getState().boardLink, { boardId: "b3", projectId: "p3", commentId: null });
    useStore.getState().clearBoardLink();
    useStore.setState({ view: "studio" });
    useStore.getState().openBoardLink({ type: "open-board" });
    assert.equal(useStore.getState().view, "studio");
    assert.equal(useStore.getState().boardLink, null);
  } finally {
    useStore.setState(previous, true);
  }
});

test("an object link without a comment is left for the board view", () => {
  const win = fakeWindow("https://veevee.test/?board=b1&project=p1&object=n1");
  const opened = [];
  watchBoardLinks(win, (link) => opened.push(link))();
  assert.deepEqual(opened, []);
  assert.equal(win.location.href, "https://veevee.test/?board=b1&project=p1&object=n1");
});
