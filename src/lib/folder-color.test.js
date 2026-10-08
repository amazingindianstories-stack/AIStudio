import test from "node:test";
import assert from "node:assert/strict";
import {
  VALID_FOLDER_COLORS,
  FOLDER_COLOR_OPTIONS,
  normalizeFolderColor,
  isValidFolderColor,
  getFolderColorClass,
} from "./folder-colors.js";

test("VALID_FOLDER_COLORS contains the 8 Finder-style color tokens", () => {
  const expected = ["gray", "red", "orange", "yellow", "green", "blue", "purple", "pink"];
  assert.equal(VALID_FOLDER_COLORS.size, 8);
  for (const c of expected) {
    assert.ok(VALID_FOLDER_COLORS.has(c), `Missing color token: ${c}`);
  }
});

test("FOLDER_COLOR_OPTIONS includes Default and all 8 color options with dotClass and textClass", () => {
  assert.equal(FOLDER_COLOR_OPTIONS.length, 9);
  assert.equal(FOLDER_COLOR_OPTIONS[0].id, "default");
  for (const opt of FOLDER_COLOR_OPTIONS) {
    assert.ok(opt.id, "option has id");
    assert.ok(opt.label, "option has label");
    assert.ok(opt.textClass, "option has textClass");
    assert.ok(opt.dotClass, "option has dotClass");
  }
});

test("normalizeFolderColor handles tokens, cases, and resets", () => {
  assert.equal(normalizeFolderColor("red"), "red");
  assert.equal(normalizeFolderColor("RED"), "red");
  assert.equal(normalizeFolderColor("  Blue  "), "blue");
  assert.equal(normalizeFolderColor("default"), null);
  assert.equal(normalizeFolderColor(""), null);
  assert.equal(normalizeFolderColor(null), null);
  assert.equal(normalizeFolderColor(undefined), null);
  assert.equal(normalizeFolderColor("unknown-color"), null);
});

test("isValidFolderColor validates allowed color tokens", () => {
  assert.equal(isValidFolderColor("blue"), true);
  assert.equal(isValidFolderColor("YELLOW"), true);
  assert.equal(isValidFolderColor(null), true);
  assert.equal(isValidFolderColor(undefined), true);
  assert.equal(isValidFolderColor("default"), true);
  assert.equal(isValidFolderColor(""), true);
  assert.equal(isValidFolderColor("magenta"), false);
  assert.equal(isValidFolderColor("neon-green"), false);
  assert.equal(isValidFolderColor("black"), false);
});

test("getFolderColorClass maps colors to Tailwind classes safely", () => {
  assert.equal(getFolderColorClass("red"), "text-rose-400");
  assert.equal(getFolderColorClass("blue"), "text-sky-400");
  assert.equal(getFolderColorClass("green"), "text-emerald-400");
  assert.equal(getFolderColorClass("yellow"), "text-yellow-400");
  assert.equal(getFolderColorClass("orange"), "text-orange-400");
  assert.equal(getFolderColorClass("purple"), "text-purple-400");
  assert.equal(getFolderColorClass("pink"), "text-pink-400");
  assert.equal(getFolderColorClass("gray"), "text-neutral-400");
  assert.equal(getFolderColorClass(null), "text-amber-400/90");
  assert.equal(getFolderColorClass("invalid"), "text-amber-400/90");
});
