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
  PORTRAIT_VIDEO_MAX_BYTES,
  portraitVideoProblem,
  isVideoPortrait,
  portraitMediaUrl,
  portraitPosterUrl,
  portraitAttachable,
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

test("overlapping drops register in drop order, and a failed or refused file never blocks the queue", async () => {
  const sent = [];
  const register = async (batch) => { sent.push(batch.map((b) => b.name)); };
  const entry = (name) => ({ referenceId: `r-${name}`, name });
  const first = createOrderedRegistrar(2, register);
  const second = createOrderedRegistrar(2, register, first.finished);
  const third = createOrderedRegistrar(1, register, second.finished);
  // The later drops finish uploading first.
  void third.settle(0, entry("e"));
  void second.settle(0, entry("c"));
  void second.settle(1, entry("d"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(sent, [], "nothing goes while the first drop still has a file uploading");
  void first.settle(1, entry("b"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(sent, [], "b still waits for a");
  void first.settle(0, null);
  await third.done();
  assert.deepEqual(sent, [["b"], ["c"], ["d"], ["e"]], "one global order; the failed file only releases the queue");
  await Promise.all([first.finished, second.finished, third.finished]);
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
  assert.equal(portraitFileProblem({ name: "a.mp4", type: "video/mp4", size: 10 }), null);
  assert.equal(portraitFileProblem({ name: "a.mov", type: "", size: 10 }), null, "extension fallback for a clip");
  assert.match(portraitFileProblem({ name: "a.webm", type: "video/webm", size: 10 }), /Only MP4 and MOV videos/);
  assert.match(portraitFileProblem({ name: "a.pdf", type: "application/pdf", size: 10 }), /Only images and MP4 or MOV videos/);
  assert.match(portraitFileProblem({ name: "big.mp4", type: "video/mp4", size: PORTRAIT_VIDEO_MAX_BYTES + 1 }), /larger than 200 MB/);
  assert.equal(portraitFileProblem({ name: "ok.mov", type: "video/quicktime", size: PORTRAIT_VIDEO_MAX_BYTES }), null, "clips may exceed the 30 MB image limit");
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

test("clips are checked against the documented duration, size and shape before upload", () => {
  const ok = { seconds: 8, width: 1080, height: 1920 };
  assert.equal(portraitVideoProblem(ok), null);
  assert.equal(portraitVideoProblem(null), null, "unreadable here: the server decides");
  assert.match(portraitVideoProblem({ ...ok, seconds: 1.2 }), /Too short \(1\.2 s\)\. Use a clip of 2 to 30 seconds\./);
  assert.match(portraitVideoProblem({ ...ok, seconds: 45 }), /Too long \(45 s\)/);
  assert.equal(portraitVideoProblem({ ...ok, width: 200, height: 400 }), "Too small (200 x 400 px). Use at least 300 px on each side.");
  assert.equal(portraitVideoProblem({ ...ok, width: 480, height: 640 }), "Too small (480 x 640 px). Use at least 640 x 640 px.");
  assert.equal(portraitVideoProblem({ ...ok, width: 640, height: 640 }), null);
  assert.match(portraitVideoProblem({ ...ok, width: 7000, height: 4000 }), /Too large/);
  assert.match(portraitVideoProblem({ ...ok, width: 3000, height: 1000 }), /Too wide/);
  assert.match(portraitVideoProblem({ ...ok, width: 600, height: 3000 }), /Too tall/);
  for (const info of [{ ...ok, seconds: 1 }, { ...ok, width: 200, height: 100 }]) assert.ok(!portraitVideoProblem(info).includes("\u2014"));
});

test("a video portrait uses its clip and poster; an image portrait its image", () => {
  const clip = { kind: "video", videoUrl: "/api/media/v.mp4", posterUrl: "/api/media/thumbs/poster/v.mp4.webp", imageUrl: null, state: "ready" };
  const still = { kind: "image", imageUrl: "/api/media/i.png", state: "ready" };
  assert.equal(isVideoPortrait(clip), true);
  assert.equal(isVideoPortrait(still), false);
  assert.equal(portraitMediaUrl(clip), clip.videoUrl);
  assert.equal(portraitPosterUrl(clip), clip.posterUrl);
  assert.equal(portraitMediaUrl(still), still.imageUrl);
  assert.equal(portraitPosterUrl(still), still.imageUrl);
  assert.equal(portraitAttachable(clip), true);
  assert.equal(portraitAttachable({ ...clip, state: "unusable" }), false);
});
