import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { AgentModelPicker } from "./AgentModelPicker.jsx";
import { useStore } from "../lib/store";

async function harness(run) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  const names = ["window", "document", "HTMLElement", "Node", "React", "IS_REACT_ACT_ENVIRONMENT", "ResizeObserver", "requestAnimationFrame",
    "cancelAnimationFrame", "getComputedStyle"];
  const prior = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  const observer = class { observe() {} unobserve() {} disconnect() {} };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, React,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout, ResizeObserver: observer,
    getComputedStyle: dom.window.getComputedStyle });
  const previous = useStore.getState();
  const root = createRoot(document.querySelector("#root"));
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  try {
    await run({ root, settle });
  } finally {
    await act(async () => root.unmount());
    useStore.setState(previous, true);
    Object.assign(globalThis, prior);
    dom.window.close();
  }
}

const trigger = () => document.querySelector("button[aria-haspopup=menu]");
const radios = (group) => [...document.querySelectorAll(`[role=group][aria-label="${group}"] [role=menuitemradio]`)];
const checked = (group) => radios(group).filter((item) => item.getAttribute("aria-checked") === "true").map((item) => item.textContent);

test("the agent model control picks the model and a thinking level that model takes, and names both on its pill", async () => {
  await harness(async ({ root, settle }) => {
    useStore.setState({ agentModel: "gemini-3.8-flash", agentThinking: "MEDIUM" });
    await act(async () => root.render(React.createElement(AgentModelPicker)));
    assert.equal(trigger().getAttribute("aria-label"), "Agent model: Gemini 3.8 Flash, Medium thinking");
    assert.match(trigger().textContent, /^Flash· Medium$/);

    await act(async () => trigger().click());
    await settle();
    assert.deepEqual(radios("Agent model").map((item) => item.firstChild.firstChild.textContent), ["Gemini 3.8 Flash", "Gemini 3.1 Pro"]);
    assert.deepEqual(checked("Agent model").map((text) => text.replace(/Fast.*/, "")), ["Gemini 3.8 Flash"]);
    assert.deepEqual(radios("Thinking level").map((item) => item.textContent), ["Low", "Medium", "High"]);
    assert.deepEqual(checked("Thinking level"), ["Medium"]);
    assert.match(document.body.textContent, /More thinking is slower and costs more\./);

    // Picking a model keeps the menu open for the level; picking a level closes it.
    await act(async () => radios("Agent model")[1].click());
    assert.equal(useStore.getState().agentModel, "gemini-3.1-pro-preview");
    assert.equal(useStore.getState().agentThinking, "MEDIUM");
    assert.deepEqual(radios("Thinking level").map((item) => item.textContent), ["Low", "Medium", "High"]);
    await act(async () => radios("Thinking level")[2].click());
    await settle();
    assert.equal(useStore.getState().agentThinking, "HIGH");
    assert.equal(trigger().getAttribute("aria-expanded"), "false");
    assert.equal(trigger().getAttribute("aria-label"), "Agent model: Gemini 3.1 Pro, High thinking");
    assert.match(trigger().textContent, /^3\.1 Pro· High$/);
  });
});

test("while a run is going the menu says the choice applies from the next run", async () => {
  await harness(async ({ root, settle }) => {
    await act(async () => root.render(React.createElement(AgentModelPicker, { running: true })));
    await act(async () => trigger().click());
    await settle();
    assert.match(document.body.textContent, /Applies from the next run; the running agent keeps its model\./);
  });
});
