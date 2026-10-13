import assert from "node:assert/strict";
import test from "node:test";
import { portraitLibraryFull } from "./portrait-readiness.js";

const quota = (updatedAt) => ({ status: "RegistrationFailed", statusMessage: JSON.stringify({ state: "REJECTED", error_code: "QuotaSharedPoolExceeded" }), updatedAt });
const active = (updatedAt) => ({ status: "Active", byteplusAssetId: "a", updatedAt });
const NOW = 10_000_000;

test("a quota rejection after the last registration means the library is full", () => {
  assert.deepEqual(portraitLibraryFull([active(100), quota(200)], { now: NOW }), { full: true, since: 200, freedSince: false });
});

test("a later successful registration or a confirmed remote delete clears it", () => {
  assert.equal(portraitLibraryFull([quota(200), active(300)], { now: NOW }).full, false);
  const freed = portraitLibraryFull([quota(200)], { freedAt: 250, now: NOW });
  assert.equal(freed.full, false);
  assert.equal(freed.freedSince, true);
});

test("other failures, old rejections and empty galleries do not block", () => {
  const other = { status: "RegistrationFailed", statusMessage: JSON.stringify({ error_code: "dimensions_out_of_bounds" }), updatedAt: 500 };
  assert.equal(portraitLibraryFull([other], { now: NOW }).full, false);
  assert.equal(portraitLibraryFull([quota(1)], { now: 8 * 24 * 60 * 60 * 1000 }).full, false);
  assert.equal(portraitLibraryFull([], { now: NOW }).full, false);
  assert.equal(portraitLibraryFull([{ status: "RegistrationFailed", statusMessage: "not json", updatedAt: 9 }], { now: NOW }).full, false);
});

test("a rejection seen during this session counts even before the gallery reloads", () => {
  assert.equal(portraitLibraryFull([active(100)], { fullAt: 400, now: NOW }).full, true);
});
