import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { ImageOptionsSettings, ImageOptionsSummary, ResolutionSegment } from "./ComposerControls.jsx";
import { useStore } from "../lib/store";

function ssr(component, props) {
  const previousReact = globalThis.React;
  globalThis.React = React;
  try {
    return renderToString(React.createElement(component, props));
  } finally {
    globalThis.React = previousReact;
  }
}

function Settings() {
  const s = useStore();
  return React.createElement(ImageOptionsSettings, { s });
}

test("the composer offers Quality and Background for GPT Image 2.5 and writes the choice to the store", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const keys = ["window", "document", "React", "IS_REACT_ACT_ENVIRONMENT"];
  const previousGlobals = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, React, IS_REACT_ACT_ENVIRONMENT: true });
  const previous = useStore.getState();
  useStore.setState({ mode: "image", model: "GPT Image 2.5 Flare", imageQuality: "high", imageBackground: "opaque" });
  const root = createRoot(document.querySelector("#root"));
  try {
    await act(async () => root.render(React.createElement(Settings)));
    const buttons = () => [...document.querySelectorAll("button")];
    const pressed = () => buttons().filter((button) => button.getAttribute("aria-pressed") === "true").map((button) => button.textContent);
    assert.deepEqual(buttons().map((button) => button.textContent), ["Low", "Medium", "High", "X-High", "Max", "Opaque", "Transparent"]);
    assert.deepEqual(pressed(), ["High", "Opaque"]);
    await act(async () => buttons().find((button) => button.textContent === "X-High").click());
    await act(async () => buttons().find((button) => button.textContent === "Transparent").click());
    assert.equal(useStore.getState().imageQuality, "xhigh");
    assert.equal(useStore.getState().imageBackground, "transparent");
    assert.deepEqual(pressed(), ["X-High", "Transparent"]);

    await act(async () => useStore.getState().setModel("Nano Banana Pro"));
    assert.equal(document.querySelector("#root").innerHTML, "");
    await act(async () => useStore.setState({ mode: "video", model: "Seedance 2.5" }));
    assert.equal(document.querySelector("#root").innerHTML, "");
  } finally {
    await act(async () => root.unmount());
    useStore.setState(previous, true);
    Object.assign(globalThis, previousGlobals);
    dom.window.close();
  }
});

test("the collapsed settings chip names the quality and only a transparent background", () => {
  const render = (s) => ssr(ImageOptionsSummary, { s });
  assert.match(render({ mode: "image", model: "GPT Image 2.5 Sunburst", imageQuality: "max", imageBackground: "transparent" }), />Max<.*>Transparent</);
  const opaque = render({ mode: "image", model: "GPT Image 2.5 Sunburst", imageQuality: "low", imageBackground: "opaque" });
  assert.match(opaque, />Low</);
  assert.doesNotMatch(opaque, /Opaque|Transparent/);
  assert.equal(render({ mode: "image", model: "Nano Banana Pro", imageQuality: "max", imageBackground: "transparent" }), "");
});

test("the resolution picker shows GPT Image 2.5's exact pixels and marks sizes above 2560x1440 experimental", () => {
  const render = (model, aspectRatio) => {
    const { document } = new JSDOM(ssr(ResolutionSegment, { model, aspectRatio, options: ["1K", "2K", "4K"], value: "2K", onChange() {} })).window;
    return { buttons: [...document.querySelectorAll("button")].map((button) => button.textContent),
      notes: [...document.querySelectorAll("p")].map((paragraph) => paragraph.textContent).slice(1) };
  };
  for (const model of ["GPT Image 2.5 Sunburst", "GPT Image 2.5 Flare"]) {
    assert.deepEqual(render(model, "1:1"), { buttons: ["1K · 1024x1024", "2K · 2048x2048", "4K · 2880x2880"],
      notes: ["2K and 4K are experimental at OpenAI (above 2560×1440 pixels)."] });
    assert.deepEqual(render(model, "16:9"), { buttons: ["1K · 1280x720", "2K · 2048x1152", "4K · 3840x2160"],
      notes: ["4K is experimental at OpenAI (above 2560×1440 pixels)."] });
  }
  for (const model of ["Nano Banana Pro", "Seedream 5.0 Pro"]) {
    assert.deepEqual(render(model, "1:1"), { buttons: ["1K", "2K", "4K"], notes: [] });
  }
});
