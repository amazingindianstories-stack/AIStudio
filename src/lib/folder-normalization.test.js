import assert from "node:assert/strict";
import test from "node:test";
import {
  validateAndNormalizeFolderName,
  MAX_FOLDER_NAME_LENGTH,
} from "./folder-normalization.js";

test("validateAndNormalizeFolderName: valid names in various languages and scripts", () => {
  const cases = [
    { input: "Anime", expectedDisplay: "Anime", expectedNorm: "anime" },
    { input: "  Characters  ", expectedDisplay: "Characters", expectedNorm: "characters" },
    { input: "Folder 123 !@#", expectedDisplay: "Folder 123 !@#", expectedNorm: "folder 123 !@#" },
    { input: "プロジェクトA", expectedDisplay: "プロジェクトA", expectedNorm: "プロジェクトa" },
    { input: "Café au Lait", expectedDisplay: "Café au Lait", expectedNorm: "café au lait" },
    { input: "Креативы 2026", expectedDisplay: "Креативы 2026", expectedNorm: "креативы 2026" },
  ];

  for (const c of cases) {
    const res = validateAndNormalizeFolderName(c.input);
    assert.equal(res.valid, true);
    assert.equal(res.displayName, c.expectedDisplay);
    assert.equal(res.normalizedName, c.expectedNorm);
  }
});

test("validateAndNormalizeFolderName: Unicode normalization collisions", () => {
  // Composed vs decomposed unicode: e.g. é as single code point vs e + combining acute
  const composed = "Caf\u00E9";
  const decomposed = "Cafe\u0301";

  const res1 = validateAndNormalizeFolderName(composed);
  const res2 = validateAndNormalizeFolderName(decomposed);

  assert.equal(res1.valid, true);
  assert.equal(res2.valid, true);
  assert.equal(res1.displayName, res2.displayName);
  assert.equal(res1.normalizedName, res2.normalizedName);
});

test("validateAndNormalizeFolderName: rejects empty, whitespace, and excessive length", () => {
  assert.equal(validateAndNormalizeFolderName("").valid, false);
  assert.equal(validateAndNormalizeFolderName("   \t\n  ").valid, false);
  assert.equal(validateAndNormalizeFolderName(null).valid, false);
  assert.equal(validateAndNormalizeFolderName(undefined).valid, false);

  const tooLong = "a".repeat(MAX_FOLDER_NAME_LENGTH + 1);
  const longRes = validateAndNormalizeFolderName(tooLong);
  assert.equal(longRes.valid, false);
  assert.match(longRes.error, /cannot exceed/);
});

test("validateAndNormalizeFolderName: rejects control characters", () => {
  const badNames = [
    "Folder\x00Name",
    "Folder\x07Alert",
    "Folder\x1B[Escape",
    "Folder\x7FDelete",
    "Folder\u009FControl",
  ];

  for (const bad of badNames) {
    const res = validateAndNormalizeFolderName(bad);
    assert.equal(res.valid, false, `Expected ${JSON.stringify(bad)} to be rejected`);
    assert.match(res.error, /control characters/);
  }
});
