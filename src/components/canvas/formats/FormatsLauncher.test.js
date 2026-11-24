import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panel = readFileSync(new URL("./FormatsPanel.jsx", import.meta.url), "utf8");
const toolbar = readFileSync(new URL("../CanvasToolbar.jsx", import.meta.url), "utf8");

test("the floating Formats pill is gone and the panel uses the dark tokens", () => {
  assert.doesNotMatch(panel, /bottom-20 right-60/);
  assert.doesNotMatch(panel, /Formats\{status/);
  assert.match(panel, /bg-ink-750/);
  const drawer = panel.slice(panel.indexOf('aria-label="Board formats"') - 400, panel.indexOf('aria-label="Board formats"'));
  assert.doesNotMatch(drawer, /bg-white |text-slate|border-slate/);
});

test("the toolbar opens the drawer from a labelled icon button with a status dot", () => {
  assert.match(toolbar, /aria-label="Docs, slides and prototypes"/);
  assert.match(toolbar, /FileText/);
  assert.match(toolbar, /board-formats-toggle/);
  assert.match(panel, /board-formats-toggle/);
  assert.match(toolbar, /-right-0\.5 -top-0\.5 h-2 w-2 rounded-full bg-brand/);
});
