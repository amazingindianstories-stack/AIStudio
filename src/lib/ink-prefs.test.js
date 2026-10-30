import test from "node:test";
import assert from "node:assert/strict";
import { inkStyleFor, normalizeInkPrefs } from "./ink-prefs";
import { HIGHLIGHTER_COLORS, PEN_COLORS, PEN_WIDTHS } from "./canvas/ink";

test("preferences fall back to defaults for anything out of range", () => {
  assert.deepEqual(normalizeInkPrefs(null), { penColor: 0, penWidth: 1, highlighterColor: 0, highlighterWidth: 1, preciseEraser: false, smartDraw: false });
  assert.equal(normalizeInkPrefs({ penColor: 9, penWidth: -1 }).penColor, 0);
  assert.equal(normalizeInkPrefs({ preciseEraser: "yes" }).preciseEraser, false);
  assert.equal(normalizeInkPrefs({ smartDraw: true }).smartDraw, true);
});

test("the pen and highlighter styles come from their presets", () => {
  const prefs = normalizeInkPrefs({ penColor: 2, penWidth: 2, highlighterColor: 1 });
  assert.deepEqual(inkStyleFor("pen", prefs), { stroke: PEN_COLORS[2], strokeWidth: PEN_WIDTHS[2] });
  const marker = inkStyleFor("highlighter", prefs);
  assert.equal(marker.highlighter, true);
  assert.equal(marker.stroke, HIGHLIGHTER_COLORS[1]);
});
