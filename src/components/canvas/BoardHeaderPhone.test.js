import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (f) => fs.readFileSync(new URL(f, import.meta.url), "utf8");

test("phone board header is one horizontally scrollable row", () => {
  const src = read("./CanvasView.jsx");
  assert.match(src, /max-sm:flex-nowrap max-sm:overflow-x-auto max-sm:pr-4 scroll-thin/);
});

test("board menu panel escapes the scrolling header on phone", () => {
  assert.match(read("./BoardExtras.jsx"), /max-sm:fixed max-sm:left-4 max-sm:right-4/);
});

test("empty board shows phone copy that does not point at a missing left panel", () => {
  const src = read("./CanvasSurface.jsx");
  assert.match(src, /hidden max-sm:inline">Tap \+ to add a card or asset\./);
  assert.match(src, /max-sm:hidden">Pick a tool below, or drag an asset from the left/);
});
