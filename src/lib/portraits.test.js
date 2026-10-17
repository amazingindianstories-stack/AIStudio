import assert from "node:assert/strict";
import test from "node:test";
import {
  PORTRAIT_MAX_BYTES,
  appendPortraitPage,
  createOrderedRegistrar,
  mergePortraitPage,
  portraitDimensionProblem,
  portraitDropImages,
  portraitFileProblem,
  portraitNameFromFile,
  portraitPollDelay,
  runPool,
  sortPortraits,
} from "./portraits.js";
import { droppedLibraryItems } from "./asset-drag-contract.js";

const p = (id, createdAt, extra = {}) => ({ id, createdAt, name: id, state: "ready", ...extra });

test("registration goes out in drop order even when files finish out of order", async () => {
  const sent = [];
  const registrar = createOrderedRegistrar(5, async (batch) => { sent.push(batch.map((b) => b.name)); });
  const entry = (name) => ({ referenceId: `r-${name}`, name });
  await registrar.settle(2, entry("c"));
  await registrar.settle(1, entry("b"));
  assert.deepEqual(sent, [], "nothing can go before the first file is done");
  await registrar.settle(0, entry("a"));
  assert.deepEqual(sent, [["a", "b", "c"]], "the finished prefix goes together, in order");
  await registrar.settle(4, entry("e"));
  assert.equal(sent.length, 1, "e waits for d");
  await registrar.settle(3, null);
  assert.deepEqual(sent, [["a", "b", "c"], ["e"]], "a failed file is skipped, not waited for");
});

test("registration batches are capped at 50 and sent one after another", async () => {
  const order = [];
  let running = 0, overlap = 0;
  const registrar = createOrderedRegistrar(120, async (batch) => {
    running += 1; overlap = Math.max(overlap, running);
    await new Promise((resolve) => setTimeout(resolve, 2));
    order.push(batch.map((b) => b.index));
    running -= 1;
  });
  for (let i = 119; i >= 0; i -= 1) void registrar.settle(i, { referenceId: `r${i}`, name: `n${i}` });
  await registrar.done();
  assert.deepEqual(order.map((b) => b.length), [50, 50, 20]);
  assert.deepEqual(order.flat(), Array.from({ length: 120 }, (_, i) => i));
  assert.equal(overlap, 1);
});

test("the pool never runs more than the limit at once and visits everything", async () => {
  let running = 0, peak = 0;
  const seen = [];
  await runPool([...Array(10).keys()], 3, async (item) => {
    running += 1; peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 3));
    seen.push(item);
    running -= 1;
  });
  assert.equal(peak, 3);
  assert.deepEqual(seen.sort((a, b) => a - b), [...Array(10).keys()]);
});

test("a refresh replaces the covered range, drops removed items and keeps later pages", () => {
  const current = [p("e", 50), p("d", 40), p("c", 30), p("b", 20), p("a", 10)];
  const merged = mergePortraitPage(current, [p("f", 60), p("e", 50), p("c", 30, { state: "ready" })], "cursor-2");
  assert.deepEqual(merged.items.map((i) => i.id), ["f", "e", "c", "b", "a"], "d left the covered range, b and a are older than the page");
  assert.equal(merged.keepNext, true);
  const whole = mergePortraitPage(current, [p("e", 50)], null);
  assert.deepEqual(whole.items.map((i) => i.id), ["e"], "a page with no next covers everything");
  assert.equal(whole.keepNext, false);
});

test("paging appends without duplicating and sorting is newest first with id tiebreak", () => {
  assert.deepEqual(appendPortraitPage([p("a", 3), p("b", 2)], [p("b", 2), p("c", 1)]).map((i) => i.id), ["a", "b", "c"]);
  assert.deepEqual(sortPortraits([p("a", 1), p("z", 5), p("m", 5)]).map((i) => i.id), ["z", "m", "a"]);
});

test("polling starts at 3 seconds and eases out to 15", () => {
  assert.equal(portraitPollDelay(0), 3000);
  assert.ok(portraitPollDelay(1) > 3000);
  assert.equal(portraitPollDelay(20), 15000);
  const delays = [0, 1, 2, 3, 4, 5, 6].map(portraitPollDelay);
  assert.deepEqual(delays, [...delays].sort((a, b) => a - b));
});

test("files over 30 MB, empty files and non-images are refused before any upload", () => {
  assert.equal(portraitFileProblem({ name: "a.png", type: "image/png", size: 10 }), null);
  assert.equal(portraitFileProblem({ name: "a.jpg", type: "", size: 10 }), null, "extension fallback when the browser gives no type");
  assert.match(portraitFileProblem({ name: "big.png", type: "image/png", size: PORTRAIT_MAX_BYTES + 1 }), /larger than 30 MB/);
  assert.equal(portraitFileProblem({ name: "exact.png", type: "image/png", size: PORTRAIT_MAX_BYTES }), null);
  assert.match(portraitFileProblem({ name: "a.mp4", type: "video/mp4", size: 10 }), /Only image files/);
  assert.match(portraitFileProblem({ name: "a.png", type: "image/png", size: 0 }), /empty/);
});

test("portrait names come from the file name", () => {
  assert.equal(portraitNameFromFile({ name: "Sati front.v2.png" }), "Sati front.v2");
  assert.equal(portraitNameFromFile({ name: ".png" }), "Portrait");
  assert.equal(portraitNameFromFile({ name: `${"x".repeat(200)}.png` }).length, 120);
});

test("only image items are taken from a library drop, and drops from outside the app yield none", () => {
  const items = [{ id: "i", kind: "image", url: "/api/media/i" }, { id: "v", kind: "video", url: "/api/media/v" }, { id: "n", kind: "image" }];
  assert.deepEqual(portraitDropImages(items).map((i) => i.id), ["i"]);
  assert.deepEqual(portraitDropImages(null), []);
  const files = { dataTransfer: { types: ["Files"], getData: () => "" } };
  assert.equal(droppedLibraryItems(files, null), null);
  const inApp = droppedLibraryItems({ dataTransfer: { types: [], getData: () => "" } }, { draggedAssets: items });
  assert.deepEqual(portraitDropImages(inApp).map((i) => i.id), ["i"]);
});

test("images outside 300-6000 px per side or a 0.4-2.5 ratio are refused with their size in the copy", () => {
  assert.equal(portraitDimensionProblem(1000, 1500), null);
  assert.equal(portraitDimensionProblem(300, 300), null);
  assert.equal(portraitDimensionProblem(6000, 3000), null);
  assert.equal(portraitDimensionProblem(0, 0), null, "unknown size is left to the server");
  assert.equal(portraitDimensionProblem(240, 180), "Too small (240 x 180 px). Use at least 300 px on each side.");
  assert.equal(portraitDimensionProblem(6001, 4000), "Too large (6001 x 4000 px). Use at most 6000 px on each side.");
  assert.match(portraitDimensionProblem(3000, 1000), /^Too wide/);
  assert.match(portraitDimensionProblem(1000, 3000), /^Too tall/);
});
