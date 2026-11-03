import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { GlobalLimitCard } from "./AdminDashboard.jsx";
import { limitDefinition } from "../lib/limits.js";

async function mount(def, limits, run) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const keys = ["window", "document", "HTMLElement", "Element", "Node", "fetch", "React", "IS_REACT_ACT_ENVIRONMENT"];
  const before = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
  const posts = [];
  let reloads = 0;
  Object.assign(globalThis, {
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element,
    Node: dom.window.Node, React, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (url, options) => {
      posts.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true }) };
    },
  });
  const root = createRoot(document.querySelector("#root"));
  const render = (next) => act(async () => root.render(React.createElement(GlobalLimitCard, { def, data: { limits: next }, reload: () => { reloads += 1; } })));
  // react-dom was loaded before this DOM existed, so hand events to the element's own React handlers.
  const props = (element) => element[Object.keys(element).find((key) => key.startsWith("__reactProps$"))];
  const input = () => document.querySelector("input");
  try {
    await render(limits);
    await run({
      posts, input, render, reloads: () => reloads,
      type: (value) => act(async () => {
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input()), "value").set.call(input(), value);
        props(input()).onChange({ target: input(), currentTarget: input() });
      }),
      blur: () => act(async () => { await props(input()).onBlur(); }),
      reset: () => {
        const button = Array.from(document.querySelectorAll("button")).find((element) => element.textContent === "Reset to default");
        return button && act(async () => { await props(button).onClick(); });
      },
    });
  } finally {
    // A save shows its check mark for two seconds; let that timer end while this DOM still exists.
    if (posts.length) await act(async () => new Promise((resolve) => setTimeout(resolve, 2100)));
    await act(async () => root.unmount());
    for (const key of keys) Object.defineProperty(globalThis, key, { value: before[key], configurable: true, writable: true });
    dom.window.close();
  }
}

test("an unset Agents tab switch shows admins only, and leaving the field never posts the kill switch", async () => {
  await mount(limitDefinition("agentsEnabled"), {}, async ({ posts, input, blur, reset }) => {
    assert.equal(input().value, "");
    assert.equal(input().getAttribute("placeholder"), "Unset: admins only");
    assert.equal(reset(), undefined, "nothing to reset while unset");
    await blur();
    assert.deepEqual(posts, []);
  });
});

test("the Agents tab switch can be killed and then reset to admins only", async () => {
  await mount(limitDefinition("agentsEnabled"), {}, async ({ posts, type, blur, render, input, reset, reloads }) => {
    await type("0");
    await blur();
    assert.deepEqual(posts, [{ url: "/api/admin/limits", body: { key: "agentsEnabled", value: 0 } }]);
    await render({ agentsEnabled: 0 });
    assert.equal(input().value, "0");
    await reset();
    assert.deepEqual(posts[1], { url: "/api/admin/limits", body: { key: "agentsEnabled", value: null } });
    assert.equal(reloads(), 2);
    await render({});
    assert.equal(input().value, "", "back to the unset state");
  });
});

test("only limits a user can override point to the Users tab, and the kill switch says it wins", async () => {
  await mount(limitDefinition("agentGlobalDailyCapCents"), {}, async () => {
    assert.doesNotMatch(document.body.textContent, /Users tab/);
  });
  await mount(limitDefinition("agentsEnabled"), {}, async () => {
    assert.match(document.body.textContent, /Unless this is 0, a user's own value from the Users tab overrides it/);
    assert.doesNotMatch(document.body.textContent, /This is the default for every user/);
  });
  await mount(limitDefinition("maxPromptLength"), {}, async () => {
    assert.match(document.body.textContent, /This is the default for every user; give an individual user their own limit from the Users tab/);
  });
});

test("a cleared ordinary switch is refused instead of saved as 0", async () => {
  await mount(limitDefinition("boardAiEnabled"), { boardAiEnabled: 1 }, async ({ posts, type, blur, reset }) => {
    assert.equal(reset(), undefined, "only unsettable limits offer a reset");
    await type("");
    await blur();
    assert.deepEqual(posts, []);
    assert.match(document.body.textContent, /Enter a whole number from 0 to 1\./);
  });
});
