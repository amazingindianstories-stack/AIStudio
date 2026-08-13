import test from "node:test";
import assert from "node:assert/strict";
import { inlineMediaUrl, thumbUrl } from "./utils";

test("thumbUrl and inlineMediaUrl only touch our own media route", () => {
  // Data URLs and provider URLs must pass through untouched — only
  // /api/media understands either param, and appending to a data: URL
  // corrupts it.
  for (const foreign of [
    "data:image/png;base64,AAAA",
    "https://example.com/x.png",
    "blob:https://app/1234",
  ]) {
    assert.equal(thumbUrl(foreign, 480), foreign);
    assert.equal(inlineMediaUrl(foreign), foreign);
  }
});

test("both helpers join with the right separator, including when composed", () => {
  assert.equal(thumbUrl("/api/media/generations/a.png", 480), "/api/media/generations/a.png?w=480");
  assert.equal(inlineMediaUrl("/api/media/generations/a.png"), "/api/media/generations/a.png?inline=1");
  assert.equal(
    inlineMediaUrl(thumbUrl("/api/media/generations/a.png", 480)),
    "/api/media/generations/a.png?w=480&inline=1"
  );
});

test("empty inputs stay empty rather than becoming a bare query string", () => {
  assert.equal(thumbUrl(undefined, 480), undefined);
  assert.equal(thumbUrl(null, 480), undefined);
  assert.equal(inlineMediaUrl(undefined), undefined);
  assert.equal(inlineMediaUrl(null), undefined);
});
