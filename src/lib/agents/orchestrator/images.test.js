import { test } from "vitest";
import assert from "node:assert/strict";
import { imagesToParts } from "./images";

const TINY_JPEG = "data:image/jpeg;base64,QUJD";
const TINY_PNG = "data:image/png;base64,REVG";

test("imagesToParts converts data URLs to Gemini inlineData parts with the right MIME type", () => {
  assert.deepEqual(imagesToParts([TINY_JPEG, TINY_PNG]), [
    { inlineData: { mimeType: "image/jpeg", data: "QUJD" } },
    { inlineData: { mimeType: "image/png", data: "REVG" } },
  ]);
});

test("imagesToParts on an empty array returns an empty array", () => {
  assert.deepEqual(imagesToParts([]), []);
});

test("imagesToParts throws on an unsupported type (reuses storage.ts's allowlist)", () => {
  assert.throws(
    () => imagesToParts(["data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="]),
    /Unsupported image type/
  );
});
