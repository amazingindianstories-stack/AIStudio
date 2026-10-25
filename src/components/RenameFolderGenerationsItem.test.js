import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { useStore } from "../lib/store";
import { useTextRequest, settleTextRequest } from "../lib/ask-text";
import { RenameFolderGenerationsItem } from "./RenameFolderGenerationsItem";

test("only admins see the action; preview discloses skips and example and cancellation never mutates", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const keys = ["window", "document", "HTMLElement", "React", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const before = Object.fromEntries(keys.map(key => [key, globalThis[key]]));
  const original = useStore.getState(), requests = useTextRequest.getState();
  const calls = [];
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    React, IS_REACT_ACT_ENVIRONMENT: true, fetch: async () => new Response(JSON.stringify({ renamedCount: 2, skippedCount: 1,
      previewToken: "reviewed", example: { oldName: "R01_SC018_0001", newName: "R02_SC018_0001" } })) });
  useTextRequest.setState({ hostMounted: true });
  useStore.setState({ currentUser: { role: "user" }, renameFolderGenerations: async value => { calls.push(value); return { renamedCount: 2, skippedCount: 3 }; } });
  const root = createRoot(document.querySelector("#root"));
  const component = React.createElement(RenameFolderGenerationsItem, { folder: { id: "folder", name: "SC018" }, close() {} });
  try {
    await act(async () => root.render(component));
    assert.equal(document.querySelector("button"), null);
    await act(async () => useStore.setState({ currentUser: { role: "admin" } }));
    assert.match(document.querySelector("button").textContent, /Rename to match folder/);
    await act(async () => document.querySelector("button").click());
    const request = useTextRequest.getState().request;
    assert.match(request.description, /2 generations.*1 generation will be skipped.*draft or final lives in another folder/);
    assert.match(request.description, /R01_SC018_0001 → R02_SC018_0001/);
    await act(async () => settleTextRequest(false));
    assert.equal(calls.length, 0);
    await act(async () => document.querySelector("button").click());
    await act(async () => settleTextRequest(true));
    assert.deepEqual(calls, [{ id: "folder", previewToken: "reviewed" }]);
  } finally {
    await act(async () => root.unmount());
    useStore.setState(original, true); useTextRequest.setState(requests, true);
    Object.assign(globalThis, before); dom.window.close();
  }
});
