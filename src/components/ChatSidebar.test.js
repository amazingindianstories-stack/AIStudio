import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { ChatSidebar, chatLabel } from "./ChatSidebar.jsx";
import { useStore } from "../lib/store.js";

test("chatLabel shows a named chat's name and dates an untitled one so it never reads like the New chat button", () => {
  const now = new Date(2026, 10, 6, 15, 0).getTime();
  const today = new Date(2026, 10, 6, 14, 32).getTime();
  const earlier = new Date(2026, 10, 4, 9, 5).getTime();
  assert.equal(chatLabel({ name: "Spring hero", createdAt: today }, now), "Spring hero");
  const untitled = chatLabel({ name: "New chat", createdAt: today }, now);
  assert.match(untitled, /^Untitled chat · /);
  assert.ok(untitled.includes(new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(today)));
  const older = chatLabel({ name: "New chat", createdAt: earlier }, now);
  assert.ok(older.includes(new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).formatToParts(earlier)
    .find((part) => part.type === "day").value), older);
  assert.notEqual(older, untitled);
  assert.equal(chatLabel({ name: "New chat" }, now), "New chat", "no time to show");
  assert.equal(chatLabel(null), "");
});

test("ChatSidebar does not POST createConversation when list endpoint returns 500", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "http://localhost/",
  });
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement,
    React: globalThis.React,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
    fetch: globalThis.fetch,
  };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.navigator = dom.window.navigator;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.React = React;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method || "GET" });
    return { ok: false, status: 500, json: async () => ({ error: "server down" }) };
  };

  useStore.setState({ activeProjectId: "proj-1", projects: [{ id: "proj-1", name: "Proj 1" }] });
  const container = document.getElementById("root");
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(React.createElement(ChatSidebar, { conversationId: null, onConversationIdChange: () => {} }));
    });
    await act(async () => {});
    const postCalls = calls.filter((c) => c.method === "POST");
    assert.equal(postCalls.length, 0, "must not POST createConversation on 500");
    assert.match(container.textContent, /server down/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [k, v] of Object.entries(saved)) globalThis[k] = v;
  }
});
