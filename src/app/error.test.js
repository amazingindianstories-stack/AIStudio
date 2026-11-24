import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import ErrorPage from "./error.jsx";

async function mount(props, run) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const names = ["window", "document", "HTMLElement", "React", "IS_REACT_ACT_ENVIRONMENT"];
  const prior = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, React, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.querySelector("#root"));
  try {
    await act(async () => root.render(React.createElement(ErrorPage, props)));
    await run();
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, prior);
    dom.window.close();
  }
}

test("the error page shows the error message and Try again calls reset", async () => {
  let resets = 0;
  await mount({ error: new Error("Boom happened"), reset: () => { resets += 1; } }, async () => {
    assert.equal(document.querySelector("[role=alert]").textContent, "Boom happened");
    const button = [...document.querySelectorAll("button")].find((b) => b.textContent === "Try again");
    assert.ok(button);
    await act(async () => button.click());
    assert.equal(resets, 1);
  });
});

test("the error page falls back to a generic message when the error has none", async () => {
  await mount({ error: undefined, reset() {} }, async () => {
    assert.equal(document.querySelector("[role=alert]").textContent, "An unexpected error occurred.");
  });
});
