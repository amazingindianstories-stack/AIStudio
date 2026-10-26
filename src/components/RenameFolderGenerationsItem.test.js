import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { useStore } from "../lib/store";
import { useTextRequest, settleTextRequest } from "../lib/ask-text";
import { useNotices } from "../lib/notify";
import { RenameFolderGenerationsItem } from "./RenameFolderGenerationsItem";

async function withItem({ role = "admin", preview, result }, run) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const keys = ["window", "document", "HTMLElement", "React", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const before = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  const original = useStore.getState(), requests = useTextRequest.getState(), notices = useNotices.getState();
  const calls = [];
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    React, IS_REACT_ACT_ENVIRONMENT: true, fetch: async () => new Response(JSON.stringify(preview)) });
  useTextRequest.setState({ hostMounted: true, request: null });
  useNotices.setState({ notices: [] });
  useStore.setState({ currentUser: { role }, renameFolderGenerations: async value => { calls.push(value); return result; } });
  const root = createRoot(document.querySelector("#root"));
  try {
    await act(async () => root.render(React.createElement(RenameFolderGenerationsItem, { folder: { id: "folder", name: "SC018" }, close() {} })));
    await run({ calls, click: () => act(async () => document.querySelector("button").click()) });
  } finally {
    await act(async () => root.unmount());
    useStore.setState(original, true); useTextRequest.setState(requests, true); useNotices.setState(notices, true);
    Object.assign(globalThis, before); dom.window.close();
  }
}

const noticeTexts = () => useNotices.getState().notices.map(notice => [notice.text, notice.tone]);

test("only admins see the action; preview discloses skips and example and cancellation never mutates", async () => {
  await withItem({ role: "user", preview: {}, result: {} }, async () => {
    assert.equal(document.querySelector("button"), null);
  });
  const preview = { renamedCount: 2, skippedCount: 1, previewToken: "reviewed",
    example: { oldName: "R01_SC018_0001", newName: "R02_SC018_0001" } };
  await withItem({ preview, result: { renamedCount: 2, skippedCount: 3 } }, async ({ calls, click }) => {
    assert.match(document.querySelector("button").textContent, /Rename to match folder/);
    await click();
    const request = useTextRequest.getState().request;
    assert.equal(request.confirmLabel, "Rename generations");
    assert.match(request.description, /2 generations.*1 generation will be skipped.*draft or final lives in another folder/);
    assert.match(request.description, /R01_SC018_0001 → R02_SC018_0001/);
    await act(async () => settleTextRequest(false));
    assert.equal(calls.length, 0);
    await click();
    await act(async () => settleTextRequest(true));
    assert.deepEqual(calls, [{ id: "folder", previewToken: "reviewed" }]);
    assert.deepEqual(noticeTexts(), [["Renamed 2 generations. Skipped 3 generations because their draft or final lives in another folder.", "info"]]);
  });
});

test("a result without skips omits the skipped clause", async () => {
  const preview = { renamedCount: 1, skippedCount: 0, previewToken: "reviewed", example: { oldName: "R01_SC018_0001", newName: "R02_SC018_0001" } };
  await withItem({ preview, result: { renamedCount: 1, skippedCount: 0 } }, async ({ click }) => {
    await click();
    await act(async () => settleTextRequest(true));
    assert.deepEqual(noticeTexts(), [["Renamed 1 generation.", "info"]]);
  });
});

test("a preview with nothing to rename informs without a confirmation or mutation", async () => {
  await withItem({ preview: { renamedCount: 0, skippedCount: 0, previewToken: "noop", example: null }, result: {} }, async ({ calls, click }) => {
    await click();
    assert.equal(useTextRequest.getState().request, null);
    assert.equal(calls.length, 0);
    assert.deepEqual(noticeTexts(), [['No generations in "SC018" need renaming.', "info"]]);
  });
  await withItem({ preview: { renamedCount: 0, skippedCount: 2, previewToken: "noop", example: null }, result: {} }, async ({ calls, click }) => {
    await click();
    assert.equal(useTextRequest.getState().request, null);
    assert.equal(calls.length, 0);
    assert.deepEqual(noticeTexts(), [['No generations in "SC018" need renaming. Skipped 2 generations because their draft or final lives in another folder.', "info"]]);
  });
});
