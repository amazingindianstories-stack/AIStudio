import { test } from "vitest";
import assert from "node:assert/strict";
import { aspectMaxWidth, aspectToPadding, inlineMediaUrl, thumbUrl } from "./utils";

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

test("aspectMaxWidth bounds a frame's height at every aspect ratio", () => {
  // The frame's height comes from aspectToPadding, which is a percentage of
  // its WIDTH — so capping width is the only way to bound height, and the two
  // helpers have to agree. For each ratio: cap the width at the returned
  // multiple of the viewport height, apply the padding percentage to it, and
  // the result must land back on the cap rather than above it.
  const CAP_VH = 62;
  for (const ratio of ["9:16", "3:4", "1:1", "4:3", "16:9", "21:9"]) {
    const m = aspectMaxWidth(ratio).match(/calc\((\d+)vh \* ([\d.]+)\)/);
    assert.ok(m, `unparsed for ${ratio}`);
    assert.equal(Number(m[1]), CAP_VH, ratio);
    const widthVh = CAP_VH * Number(m[2]);
    const heightPct = Number(aspectToPadding(ratio).replace("%", "")) / 100;
    // Height in vh = width in vh x the padding ratio. Lands exactly on the cap.
    assert.ok(
      Math.abs(widthVh * heightPct - CAP_VH) < 0.001,
      `${ratio}: ${widthVh}vh wide renders ${widthVh * heightPct}vh tall`
    );
  }
});

test("aspectMaxWidth declines to cap what it cannot parse", () => {
  // undefined means "no max-width", i.e. the container keeps deciding — a
  // bad ratio must degrade to the old behaviour, never to a 0-width frame.
  for (const bad of [undefined, null, "", "16", "16:0", "0:9", "wide"]) {
    assert.equal(aspectMaxWidth(bad), undefined, JSON.stringify(bad));
  }
});
