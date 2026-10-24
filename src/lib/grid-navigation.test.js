import test from "node:test";
import assert from "node:assert/strict";
import { getNextGridFocus } from "./grid-navigation.js";
import { libraryCardSpacing } from "../components/AssetGrid";

test("getNextGridFocus navigates vertically within the same column", () => {
  const col0 = [{ id: "c0-0", aspectRatio: "1:1" }, { id: "c0-1", aspectRatio: "1:1" }, { id: "c0-2", aspectRatio: "1:1" }];
  const col1 = [{ id: "c1-0", aspectRatio: "1:1" }, { id: "c1-1", aspectRatio: "1:1" }];
  const columns = [col0, col1];
  const items = [...col0, ...col1];

  // Down in column 0
  assert.equal(getNextGridFocus(columns, "c0-0", "down", items), "c0-1");
  assert.equal(getNextGridFocus(columns, "c0-1", "down", items), "c0-2");
  // Down at bottom stays at bottom
  assert.equal(getNextGridFocus(columns, "c0-2", "down", items), "c0-2");

  // Up in column 0
  assert.equal(getNextGridFocus(columns, "c0-2", "up", items), "c0-1");
  assert.equal(getNextGridFocus(columns, "c0-1", "up", items), "c0-0");
  // Up at top stays at top
  assert.equal(getNextGridFocus(columns, "c0-0", "up", items), "c0-0");
});

test("getNextGridFocus navigates horizontally to the closest visual neighbor", () => {
  const col0 = [
    { id: "left-top", aspectRatio: "16:9" }, // h ~ 0.56
    { id: "left-mid", aspectRatio: "16:9" },
    { id: "left-bot", aspectRatio: "16:9" },
  ];
  const col1 = [
    { id: "right-tall", aspectRatio: "9:16" }, // h ~ 1.77
    { id: "right-bot", aspectRatio: "16:9" },
  ];
  const columns = [col0, col1];
  const items = [...col0, ...col1];

  // Right from left-top should hit right-tall
  assert.equal(getNextGridFocus(columns, "left-top", "right", items), "right-tall");

  // Left from right-tall should hit left-top or left-mid
  const fromRightTall = getNextGridFocus(columns, "right-tall", "left", items);
  assert.ok(["left-top", "left-mid"].includes(fromRightTall));

  // Left at boundary stays at current
  assert.equal(getNextGridFocus(columns, "left-top", "left", items), "left-top");

  // Right at boundary stays at current
  assert.equal(getNextGridFocus(columns, "right-bot", "right", items), "right-bot");
});

test("getNextGridFocus handles Home and End shortcuts", () => {
  const col0 = [{ id: "first" }, { id: "second" }];
  const col1 = [{ id: "third" }, { id: "last" }];
  const columns = [col0, col1];
  const items = [...col0, ...col1];

  assert.equal(getNextGridFocus(columns, "second", "home", items), "first");
  assert.equal(getNextGridFocus(columns, "second", "end", items), "last");
});

test("getNextGridFocus handles single-column layouts cleanly", () => {
  const col0 = [{ id: "item-0" }, { id: "item-1" }, { id: "item-2" }];
  const columns = [col0];
  const items = [...col0];

  assert.equal(getNextGridFocus(columns, "item-0", "right", items), "item-1");
  assert.equal(getNextGridFocus(columns, "item-1", "right", items), "item-2");
  assert.equal(getNextGridFocus(columns, "item-2", "right", items), "item-2");

  assert.equal(getNextGridFocus(columns, "item-2", "left", items), "item-1");
  assert.equal(getNextGridFocus(columns, "item-1", "left", items), "item-0");
  assert.equal(getNextGridFocus(columns, "item-0", "left", items), "item-0");
});


test("library Left/Right lands on the card beside it once each card's name row is counted", () => {
  // Two 200px library columns. Each strip is 20px media + 28px name row + 12px gap,
  // so the fifth strip spans 240-288px, beside the second square (240-468px),
  // even though the strips' media alone would put it beside the first.
  const strips = Array.from({ length: 5 }, (_, i) => ({ id: `strip-${i}`, aspectRatio: "10:1" }));
  const squares = [{ id: "square-0", aspectRatio: "1:1" }, { id: "square-1", aspectRatio: "1:1" }];
  const columns = [strips, squares];
  const items = [...strips, ...squares];
  const spacing = libraryCardSpacing(444, 200);
  assert.equal(getNextGridFocus(columns, "strip-4", "right", items, spacing), "square-1");
  assert.equal(getNextGridFocus(columns, "strip-0", "right", items, spacing), "square-0");
  assert.equal(getNextGridFocus(columns, "square-1", "left", items, spacing), "strip-4");
  // Grids whose cards have no name row (the portrait gallery) keep the media-only estimate.
  assert.equal(getNextGridFocus(columns, "strip-4", "right", items), "square-0");
});
