import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { CanvasAiPanel, panelRequest } from "./CanvasAiPanel";
import { useBoardAi } from "../../lib/board-ai";
import { useCanvasStore } from "../../lib/canvas-store";
import { useStore } from "../../lib/store";
import { AI_FORMATS } from "../../lib/canvas/ai-formats";
import { DEFAULTS, aspectRatiosForModel, resolutionsForModel } from "../../lib/config";
import { emptyCanvasState } from "../../lib/canvas/serialization";

const BOARD = "11111111-1111-4111-8111-111111111111";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function setupDom(t) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  const names = ["window", "document", "HTMLElement", "React", "IS_REACT_ACT_ENVIRONMENT", "fetch", "ResizeObserver", "requestAnimationFrame",
    "cancelAnimationFrame", "getComputedStyle", "MutationObserver", "localStorage", "Event", "KeyboardEvent"];
  const prior = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  const observer = class { observe() {} unobserve() {} disconnect() {} };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, React,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    MutationObserver: dom.window.MutationObserver, localStorage: dom.window.localStorage, ResizeObserver: observer,
    getComputedStyle: dom.window.getComputedStyle, Event: dom.window.Event, KeyboardEvent: dom.window.KeyboardEvent });
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  dom.window.HTMLElement.prototype.attachEvent = function () {};
  dom.window.HTMLElement.prototype.detachEvent = function () {};
  t.after(() => Object.assign(globalThis, prior));
  return dom;
}

// react-dom/client decides at import whether native `input` events exist, so it loads after the DOM.
async function createRoot(container) {
  return (await import("react-dom/client")).createRoot(container);
}

function serve(calls, { job, recent = [] } = {}) {
  return async (url, init = {}) => {
    const call = { url, method: init.method || "GET", headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    if (url.endsWith("/ai-jobs/quote")) {
      const costCents = (call.body.format === "image" ? 24 : 3) * (call.body.processing === "advanced" ? 4 : 1);
      return json(200, { quote: { format: call.body.format, processing: call.body.processing, model: "m", costCents } });
    }
    if (call.method === "POST") return json(201, { job: job ?? { id: call.headers["Idempotency-Key"], boardId: BOARD, format: call.body.format, prompt: call.body.prompt, status: "queued", costCents: 3 } });
    return json(200, { jobs: url.endsWith("?recent=1") ? recent : [] });
  };
}

function typeInto(element, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(element, value);
  element.dispatchEvent(new window.Event("input", { bubbles: true }));
}

const buttonByText = (text) => [...document.querySelectorAll("button")].find((element) => element.textContent.trim() === text);

test("panelRequest sends only what the format needs", () => {
  assert.equal(panelRequest({ format: "stickies", prompt: "  " }), null);
  assert.deepEqual(panelRequest({ format: "stickies", prompt: " ideas ", model: "x", aspectRatio: "1:1" }), { format: "stickies", prompt: "ideas", processing: "basic" });
  assert.deepEqual(panelRequest({ format: "stickies", prompt: "ideas", processing: "advanced" }), { format: "stickies", prompt: "ideas", processing: "advanced" });
  // An image sends the library generator's settings, not a processing choice.
  assert.deepEqual(panelRequest({ format: "image", prompt: "lamp", processing: "advanced", model: "Nano Banana Pro", aspectRatio: "16:9", resolution: "4K" }),
    { format: "image", prompt: "lamp", model: "Nano Banana Pro", aspectRatio: "16:9", resolution: "4K" });
  // A refinement sends them too (pre-filled from the image it edits), with its parent.
  assert.deepEqual(panelRequest({ format: "image", prompt: "night", model: "Nano Banana Pro", aspectRatio: "16:9", resolution: "2K", parentJobId: "p" }),
    { format: "image", prompt: "night", parentJobId: "p", model: "Nano Banana Pro", aspectRatio: "16:9", resolution: "2K" });
});

test("a refinement sends no selection context", () => {
  const extra = { context: [{ id: "a", text: "note" }] };
  assert.deepEqual(panelRequest({ format: "summary", prompt: "shorter", parentJobId: "p", extra }), { format: "summary", prompt: "shorter", processing: "basic", parentJobId: "p" });
  assert.deepEqual(panelRequest({ format: "summary", prompt: "sum", extra }).context, extra.context);
});

test("the panel shows suggestions, quotes the cost before running and submits one keyed job", async (t) => {
  setupDom(t);
  const calls = [];
  globalThis.fetch = serve(calls);
  useStore.setState({ availableModelIds: null });
  useCanvasStore.setState({ boardId: BOARD, loaded: true, history: { past: [], present: emptyCanvasState(), future: [] } });
  await useBoardAi.getState().attach(BOARD);
  let closed = 0;
  const root = await createRoot(document.querySelector("#root"));
  try {
    await act(async () => root.render(React.createElement(CanvasAiPanel, { boardId: BOARD, onClose: () => { closed += 1; } })));
    const generate = () => buttonByText("Generate");
    assert.equal(generate().disabled, true, "nothing to run yet");
    for (const suggestion of AI_FORMATS.stickies.suggestions) assert.ok(buttonByText(suggestion), suggestion);

    await act(async () => buttonByText(AI_FORMATS.stickies.suggestions[0]).click());
    const textarea = document.querySelector("textarea[aria-label='Prompt']");
    assert.equal(textarea.value, AI_FORMATS.stickies.suggestions[0]);
    assert.equal(generate().disabled, true, "the cost is shown before the job can run");
    assert.match(document.querySelector("[aria-live]").textContent, /Estimating cost/);
    await act(async () => sleep(450));
    assert.match(document.querySelector("[aria-live]").textContent, /Estimated cost ≈\$0\.03/);
    assert.equal(generate().disabled, false);
    const quote = calls.find((call) => call.url.endsWith("/quote"));
    assert.deepEqual(quote.body, { format: "stickies", prompt: AI_FORMATS.stickies.suggestions[0], processing: "basic" });

    // Advanced processing is quoted at its own price before it can run.
    await act(async () => document.querySelector("[aria-label='Processing'] button[aria-checked=false]").click());
    assert.equal(document.querySelector("[aria-label='Processing'] [aria-checked=true]").textContent, "Advanced");
    await act(async () => sleep(450));
    assert.deepEqual(calls.filter((call) => call.url.endsWith("/quote")).at(-1).body,
      { format: "stickies", prompt: AI_FORMATS.stickies.suggestions[0], processing: "advanced" });
    assert.match(document.querySelector("[aria-live]").textContent, /Estimated cost ≈\$0\.12/);

    await act(async () => generate().click());
    const posts = calls.filter((call) => call.method === "POST" && call.url.endsWith("/ai-jobs"));
    assert.equal(posts.length, 1);
    assert.match(posts[0].headers["Idempotency-Key"], /^[0-9a-f-]{36}-0$/);
    assert.deepEqual(posts[0].body, { format: "stickies", prompt: AI_FORMATS.stickies.suggestions[0], processing: "advanced" });
    assert.equal(textarea.value, "");
    assert.match(document.querySelector("[aria-live]").textContent, /Queued/);

    // The image format has the library generator's controls instead of Basic and Advanced, with its defaults, and
    // quotes what they say.
    await act(async () => document.querySelector("[aria-label='Format'] button[aria-checked=false]").click());
    assert.equal(document.querySelector("[aria-label='Processing']"), null, "an image has no Basic or Advanced choice");
    assert.ok(document.querySelector("button[aria-label^='Model: ']"));
    await act(async () => typeInto(document.querySelector("textarea"), "a lighthouse at dusk"));
    await act(async () => sleep(450));
    const defaultQuote = calls.filter((call) => call.url.endsWith("/quote")).at(-1);
    assert.deepEqual(defaultQuote.body, { format: "image", prompt: "a lighthouse at dusk", model: DEFAULTS.image.model,
      aspectRatio: DEFAULTS.image.aspectRatio, resolution: DEFAULTS.image.resolution });
    await act(async () => document.querySelector("button[aria-label='Generation settings']").click());
    assert.deepEqual([...document.querySelectorAll("button[aria-pressed]")].map((element) => element.textContent),
      [...aspectRatiosForModel(DEFAULTS.image.model, "image"), ...resolutionsForModel(DEFAULTS.image.model, "image"), "1×", "2×"]);
    await act(async () => buttonByText("16:9").click());
    await act(async () => buttonByText("4K").click());
    await act(async () => sleep(450));
    const imageQuote = calls.filter((call) => call.url.endsWith("/quote")).at(-1);
    assert.equal(imageQuote.body.format, "image");
    assert.equal(imageQuote.body.aspectRatio, "16:9");
    assert.equal(imageQuote.body.resolution, "4K");
    assert.equal(imageQuote.body.model, DEFAULTS.image.model);
    assert.equal(document.querySelector("button[aria-label='Generation settings']").textContent, "16:9·4K");

    await act(async () => document.querySelector("textarea").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(closed, 1);
  } finally {
    await act(async () => root.unmount());
    useBoardAi.getState().detach();
    useCanvasStore.getState().reset();
  }
});

test("after a result is placed the panel refines it", async (t) => {
  setupDom(t);
  const calls = [];
  globalThis.fetch = serve(calls);
  useStore.setState({ availableModelIds: null });
  await useBoardAi.getState().attach(BOARD);
  useBoardAi.setState({ placed: { jobId: "parent-job", format: "stickies", prompt: "ten shot ideas", nodeIds: ["a", "b"],
    result: { notes: [{ text: "a" }, { text: "b" }] } } });
  const root = await createRoot(document.querySelector("#root"));
  try {
    await act(async () => root.render(React.createElement(CanvasAiPanel, { boardId: BOARD, onClose() {} })));
    assert.match(document.querySelector("section").textContent, /Refining 2 sticky notes: ten shot ideas/);
    assert.equal(document.querySelector("[aria-label='Format']"), null, "a refinement keeps the result's format");
    assert.ok(document.querySelector("textarea[aria-label='Refinement']"));
    await act(async () => typeInto(document.querySelector("textarea"), "make them shorter"));
    await act(async () => sleep(450));
    assert.deepEqual(calls.filter((call) => call.url.endsWith("/quote")).at(-1).body,
      { format: "stickies", prompt: "make them shorter", processing: "basic", parentJobId: "parent-job" });
    await act(async () => buttonByText("Refine").click());
    assert.deepEqual(calls.filter((call) => call.method === "POST" && call.url.endsWith("/ai-jobs")).at(-1).body,
      { format: "stickies", prompt: "make them shorter", processing: "basic", parentJobId: "parent-job" });
    await act(async () => buttonByText("New prompt").click());
    assert.ok(document.querySelector("[aria-label='Format']"));
  } finally {
    await act(async () => root.unmount());
    useBoardAi.getState().detach();
  }
});

test("refining an image pre-fills the controls from the image and sends them, whether or not they change", async (t) => {
  setupDom(t);
  const calls = [];
  globalThis.fetch = serve(calls);
  useStore.setState({ availableModelIds: null });
  await useBoardAi.getState().attach(BOARD);
  useBoardAi.setState({ placed: { jobId: "parent-image", format: "image", prompt: "a lighthouse", nodeIds: ["a"],
    result: { url: "/api/media/x", aspectRatio: "4:5" }, model: "Nano Banana 2.1", aspectRatio: "4:5", resolution: "4K" } });
  const root = await createRoot(document.querySelector("#root"));
  try {
    await act(async () => root.render(React.createElement(CanvasAiPanel, { boardId: BOARD, onClose() {} })));
    assert.equal(document.querySelector("[aria-label='Processing']"), null);
    assert.equal(document.querySelector("button[aria-label='Model: Nano Banana 2.1']")?.textContent, "Nano Banana 2.1");
    assert.equal(document.querySelector("button[aria-label='Generation settings']").textContent, "4:5·4K");
    await act(async () => document.querySelector("button[aria-label='Generation settings']").click());
    assert.equal(buttonByText("2×"), undefined, "a refinement is always one job");
    await act(async () => document.querySelector("button[aria-label='Generation settings']").click());
    await act(async () => typeInto(document.querySelector("textarea"), "make it night"));
    await act(async () => sleep(450));
    assert.deepEqual(calls.filter((call) => call.url.endsWith("/quote")).at(-1).body,
      { format: "image", prompt: "make it night", parentJobId: "parent-image", model: "Nano Banana 2.1", aspectRatio: "4:5", resolution: "4K" });
    // The person can change any of them; a model without the ratio falls back to one it has.
    await act(async () => document.querySelector("button[aria-label='Generation settings']").click());
    await act(async () => buttonByText("2K").click());
    await act(async () => sleep(450));
    assert.deepEqual(calls.filter((call) => call.url.endsWith("/quote")).at(-1).body,
      { format: "image", prompt: "make it night", parentJobId: "parent-image", model: "Nano Banana 2.1", aspectRatio: "4:5", resolution: "2K" });
    await act(async () => buttonByText("Refine").click());
    assert.deepEqual(calls.filter((call) => call.method === "POST" && call.url.endsWith("/ai-jobs")).at(-1).body,
      { format: "image", prompt: "make it night", parentJobId: "parent-image", model: "Nano Banana 2.1", aspectRatio: "4:5", resolution: "2K" });
  } finally {
    await act(async () => root.unmount());
    useBoardAi.getState().detach();
  }
});

test("a 2× image batch shows in the settings, quotes the total and submits the same request twice, one key slot each", async (t) => {
  setupDom(t);
  const calls = [];
  globalThis.fetch = serve(calls);
  useStore.setState({ availableModelIds: null, batchCount: 1 });
  useCanvasStore.setState({ boardId: BOARD, loaded: true, history: { past: [], present: emptyCanvasState(), future: [] } });
  await useBoardAi.getState().attach(BOARD);
  const root = await createRoot(document.querySelector("#root"));
  try {
    await act(async () => root.render(React.createElement(CanvasAiPanel, { boardId: BOARD, onClose() {} })));
    await act(async () => buttonByText(AI_FORMATS.image.label).click());
    await act(async () => typeInto(document.querySelector("textarea"), "a lighthouse at dusk"));
    await act(async () => sleep(450));
    assert.match(document.querySelector("[aria-live]").textContent, /Estimated cost ≈\$0\.24/);
    const settings = () => document.querySelector("button[aria-label='Generation settings']");
    await act(async () => settings().click());
    assert.equal(buttonByText("1×").getAttribute("aria-pressed"), "true", "one job per generate by default");
    await act(async () => buttonByText("2×").click());
    assert.equal(settings().textContent, `${DEFAULTS.image.aspectRatio}·${DEFAULTS.image.resolution}·2×`);
    assert.equal(useStore.getState().batchCount, 1, "the library's batch setting is not touched");
    await act(async () => sleep(450));
    assert.match(document.querySelector("[aria-live]").textContent, /Estimated cost ≈\$0\.48 · 2 images/);
    const quotes = calls.filter((call) => call.url.endsWith("/quote"));
    assert.deepEqual(quotes.at(-1).body, { format: "image", prompt: "a lighthouse at dusk", model: DEFAULTS.image.model,
      aspectRatio: DEFAULTS.image.aspectRatio, resolution: DEFAULTS.image.resolution }, "the quote is for one job");

    await act(async () => buttonByText("Generate").click());
    const posts = calls.filter((call) => call.method === "POST" && call.url.endsWith("/ai-jobs"));
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[1].body, posts[0].body);
    const [base] = posts[0].headers["Idempotency-Key"].match(/^[0-9a-f-]{36}/);
    assert.deepEqual(posts.map((call) => call.headers["Idempotency-Key"]), [`${base}-0`, `${base}-1`]);
    assert.equal(document.querySelector("textarea").value, "");
  } finally {
    await act(async () => root.unmount());
    useBoardAi.getState().detach();
    useCanvasStore.getState().reset();
  }
});

test("recent results list the last day's finished results and place one again without a new job", async (t) => {
  setupDom(t);
  const calls = [];
  const finished = { id: "j9", boardId: BOARD, format: "stickies", prompt: "ten shot ideas", status: "succeeded", costCents: 3,
    placedAt: 5, placedNodeIds: ["gone"], result: { notes: [{ text: "Wide shot", color: "blue" }] } };
  globalThis.fetch = serve(calls, { recent: [finished] });
  useStore.setState({ availableModelIds: null });
  useCanvasStore.setState({ boardId: BOARD, loaded: true, history: { past: [], present: emptyCanvasState(), future: [] } });
  await useBoardAi.getState().attach(BOARD);
  const root = await createRoot(document.querySelector("#root"));
  try {
    await act(async () => root.render(React.createElement(CanvasAiPanel, { boardId: BOARD, onClose() {} })));
    assert.equal(document.querySelector("ul[aria-label='Recent results']"), null);
    await act(async () => document.querySelector("button[aria-label='Recent results']").click());
    const list = document.querySelector("ul[aria-label='Recent results']");
    assert.match(list.textContent, /ten shot ideas/);
    await act(async () => document.querySelector("button[aria-label='Place again: ten shot ideas']").click());
    assert.deepEqual(useCanvasStore.getState().history.present.nodes.map((node) => node.text), ["Wide shot"]);
    assert.equal(calls.filter((call) => call.method !== "GET").length, 0, "no job, quote or claim");
    assert.match(document.querySelector("section").textContent, /Refining 1 sticky note: ten shot ideas/);
  } finally {
    await act(async () => root.unmount());
    useBoardAi.getState().detach();
    useCanvasStore.getState().reset();
  }
});

test("an open recent results list follows the board after switching away and back", async (t) => {
  setupDom(t);
  const OTHER = "22222222-2222-4222-8222-222222222222";
  const finished = { id: "j9", boardId: BOARD, format: "stickies", prompt: "ten shot ideas", status: "succeeded", costCents: 3,
    placedAt: 5, placedNodeIds: ["gone"], result: { notes: [{ text: "Wide shot", color: "blue" }] } };
  globalThis.fetch = async (url) => json(200, { jobs: url.includes(BOARD) && url.endsWith("?recent=1") ? [finished] : [] });
  useStore.setState({ availableModelIds: null });
  // The board view attaches board AI only once the board has loaded, so the panel's board changes first.
  const show = async (boardId) => {
    await act(async () => root.render(React.createElement(CanvasAiPanel, { boardId, onClose() {} })));
    useCanvasStore.setState({ boardId, loaded: true, history: { past: [], present: emptyCanvasState(), future: [] } });
    await act(async () => useBoardAi.getState().attach(boardId));
    await act(async () => sleep(0));
  };
  useCanvasStore.setState({ boardId: BOARD, loaded: true, history: { past: [], present: emptyCanvasState(), future: [] } });
  await useBoardAi.getState().attach(BOARD);
  const root = await createRoot(document.querySelector("#root"));
  try {
    await show(BOARD);
    await act(async () => document.querySelector("button[aria-label='Recent results']").click());
    assert.ok(document.querySelector("button[aria-label='Place again: ten shot ideas']"));
    await show(OTHER);
    assert.match(document.querySelector("section").textContent, /No finished results/);
    await show(BOARD);
    assert.ok(document.querySelector("button[aria-label='Place again: ten shot ideas']"), "back on the board, its results are listed again");
  } finally {
    await act(async () => root.unmount());
    useBoardAi.getState().detach();
    useCanvasStore.getState().reset();
  }
});
