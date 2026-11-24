import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import NotFound from "./not-found.jsx";

test("the not-found page explains the missing page and links back to Veevee", () => {
  const prior = globalThis.React;
  globalThis.React = React;
  try {
    const html = renderToStaticMarkup(React.createElement(NotFound));
    assert.match(html, /This page does not exist/);
    assert.match(html, /<a [^>]*href="\/"[^>]*>Back to Veevee<\/a>/);
  } finally {
    globalThis.React = prior;
  }
});
