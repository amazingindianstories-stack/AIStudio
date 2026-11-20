import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { StudioChat } from "./StudioChat.jsx";

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "http://localhost/",
  });
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    navigator: globalThis.navigator,
    HTMLElement: globalThis.HTMLElement,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    React: globalThis.React,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.navigator = dom.window.navigator;
  globalThis.HTMLElement = dom.window.HTMLElement;
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.React = React;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return () => {
    dom.window.close();
    for (const [k, v] of Object.entries(saved)) globalThis[k] = v;
  };
}

test("StudioChat shows error and Retry button when fetch rejects, and clears spinner", async () => {
  const restore = installDom();
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/api/agent-conversations/conv-1")) {
      throw new Error("network down");
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const container = document.getElementById("root");
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(React.createElement(StudioChat, { conversationId: "conv-1" }));
    });
    await act(async () => {});
    assert.match(container.textContent, /Could not load this chat\./);
    assert.ok(container.querySelector("button")?.textContent?.includes("Retry") || container.textContent.includes("Retry"));
    assert.doesNotMatch(container.textContent, /Loading chat…/);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = prevFetch;
    restore();
  }
});

test("StudioChat shows error and Retry button when fetch resolves 500", async () => {
  const restore = installDom();
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("/api/agent-conversations/conv-2")) {
      return { ok: false, status: 500, json: async () => ({ error: "boom" }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  const container = document.getElementById("root");
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(React.createElement(StudioChat, { conversationId: "conv-2" }));
    });
    await act(async () => {});
    assert.match(container.textContent, /boom/);
    assert.ok(container.textContent.includes("Retry"));
    assert.doesNotMatch(container.textContent, /Loading chat…/);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = prevFetch;
    restore();
  }
});
