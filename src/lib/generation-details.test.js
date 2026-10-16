import test from "node:test";
import assert from "node:assert/strict";
import { formatElapsed, generationOutputSummary, generationTiming } from "./generation-details.js";
import { placeMenu } from "../components/CardContextMenu.jsx";

test("timing reports duration only once a generation has finished", () => {
  assert.deepEqual(generationTiming({ status: "succeeded", createdAt: 1000, submittedAt: 4000, completedAt: 64000 }),
    { createdAt: 1000, totalMs: 63000, queuedMs: 3000, renderMs: 60000 });
  assert.equal(generationTiming({ status: "running", createdAt: 1000, submittedAt: 4000 }).totalMs, null);
  assert.equal(generationTiming({ status: "succeeded", createdAt: 5000, completedAt: 1000 }).totalMs, null);
  assert.equal(generationTiming({ status: "succeeded", createdAt: "garbage" }).createdAt, null);
});

test("elapsed time is compact", () => {
  assert.equal(formatElapsed(42_400), "42s");
  assert.equal(formatElapsed(185_000), "3m 05s");
  assert.equal(formatElapsed(120_000), "2m");
  assert.equal(formatElapsed(3_720_000), "1h 02m");
  assert.equal(formatElapsed(null), null);
  assert.equal(formatElapsed(-1), null);
});

test("output summary names resolution, aspect and video duration", () => {
  assert.equal(generationOutputSummary({ kind: "video", resolution: "480p", aspectRatio: "16:9", duration: 5 }), "480p · 16:9 · 5s");
  assert.equal(generationOutputSummary({ kind: "image", aspectRatio: "1:1", duration: 5 }), "1:1");
  assert.equal(generationOutputSummary({ kind: "depth", resolution: "vitb", aspectRatio: "9:16" }, { vitb: { label: "Balanced" } }), "Balanced · 9:16");
});

test("menu placement flips at the right and bottom edges and stays inside the viewport", () => {
  const viewport = { width: 1000, height: 800 };
  const at = (x, y) => ({ left: x, right: x, top: y, bottom: y });
  assert.deepEqual(placeMenu(at(100, 100), 270, 400, viewport), { left: 100, top: 100 });
  assert.deepEqual(placeMenu(at(950, 780), 270, 400, viewport), { left: 680, top: 380 });
  assert.deepEqual(placeMenu(at(5, 300), 270, 790, viewport), { left: 8, top: 8 });
  // Anchored to a button: below it with a gap, or above it when there is no room.
  assert.deepEqual(placeMenu({ left: 900, right: 930, top: 700, bottom: 730 }, 270, 300, viewport, 4), { left: 660, top: 396 });
});
