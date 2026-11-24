import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Library } from "lucide-react";
import EmptyState from "./EmptyState.jsx";

globalThis.React = React;

test("EmptyState renders icon, title, hint and action", () => {
  const html = renderToStaticMarkup(
    React.createElement(EmptyState, { icon: Library, title: "No provider errors", hint: "No errors match these filters.", action: React.createElement("button", null, "Clear") })
  );
  assert.match(html, /<svg[^>]*aria-hidden/);
  assert.match(html, /<h3[^>]*>No provider errors<\/h3>/);
  assert.match(html, /No errors match these filters\./);
  assert.match(html, /<button>Clear<\/button>/);
});

test("EmptyState omits hint and icon when absent", () => {
  const html = renderToStaticMarkup(React.createElement(EmptyState, { title: "T" }));
  assert.doesNotMatch(html, /<svg|<p/);
});

test("admin tabs use the shared EmptyState with the agreed titles", () => {
  const read = (f) => readFileSync(new URL(f, import.meta.url), "utf8");
  assert.match(read("./AdminErrorsTab.jsx"), /title="No provider errors"/);
  assert.match(read("./AdminAiUsageTab.jsx"), /title="No board AI spend yet"/);
  assert.match(read("./AdminBoardLogsTab.jsx"), /title="No board activity yet"/);
});

test("phone nav buttons carry a title and the depth dot a role=img label", () => {
  const src = readFileSync(new URL("./TopBar.jsx", import.meta.url), "utf8");
  assert.match(src, /title=\{d\.label\}/);
  assert.match(src, /role="img"[\s\S]{0,400}Depth worker offline/);
});
