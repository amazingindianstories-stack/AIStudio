import assert from "node:assert/strict";
import test from "node:test";
import {
  chapterAt, formatTime, nextRecorderState, pickRecordingTypes, playbackWindow, reactionBuckets, recordedMs, segmentIndexAt,
  skipTo, timeAtFraction, timelineFraction, viewersSummary,
} from "./talktrack.js";

test("formatTime shows minutes and seconds, and hours when needed", () => {
  assert.equal(formatTime(0), "0:00");
  assert.equal(formatTime(65432), "1:05");
  assert.equal(formatTime(3725000), "1:02:05");
  assert.equal(formatTime(-5), "0:00");
});

test("the playback window follows the trim offsets and stays inside the recording", () => {
  assert.deepEqual(playbackWindow({ durationMs: 90000 }), { start: 0, end: 90000, length: 90000 });
  assert.deepEqual(playbackWindow({ durationMs: 90000, trimStartMs: 5000, trimEndMs: 80000 }), { start: 5000, end: 80000, length: 75000 });
  assert.deepEqual(playbackWindow({ durationMs: 1000, trimStartMs: 5000, trimEndMs: 99999 }), { start: 1000, end: 1000, length: 0 });
});

test("skip, timeline fractions and pointer times respect the window", () => {
  const window = { start: 5000, end: 55000, length: 50000 };
  assert.equal(skipTo(50000, 10000, window), 55000);
  assert.equal(skipTo(6000, -10000, window), 5000);
  assert.equal(skipTo(20000, 10000, window), 30000);
  assert.equal(timelineFraction(30000, window), 0.5);
  assert.equal(timelineFraction(0, window), 0);
  assert.equal(timeAtFraction(0.5, window), 30000);
  assert.equal(timeAtFraction(2, window), 55000);
});

test("reactions group into timeline buckets and leave out comments and moments outside the trim", () => {
  const window = { start: 0, end: 100000, length: 100000 };
  const moments = [
    { atMs: 1000, emoji: "👍" },
    { atMs: 1500, emoji: "👍" },
    { atMs: 1800, emoji: "🎉" },
    { atMs: 50000, emoji: "🔥" },
    { atMs: 60000, text: "a comment", emoji: "" },
    { atMs: 120000, emoji: "👀" },
  ];
  const buckets = reactionBuckets(moments, window, 10);
  assert.deepEqual(buckets.map((bucket) => [bucket.index, bucket.count, bucket.top]), [[0, 3, "👍"], [5, 1, "🔥"]]);
  assert.deepEqual(reactionBuckets(moments, { start: 0, end: 0, length: 0 }), []);
});

test("chapters and transcript segments are found by time", () => {
  const chapters = [{ startMs: 0, title: "a" }, { startMs: 60000, title: "b" }];
  assert.equal(chapterAt(chapters, 59999).title, "a");
  assert.equal(chapterAt(chapters, 60000).title, "b");
  assert.equal(chapterAt([{ startMs: 5000, title: "x" }], 1000), null);
  const segments = [{ startMs: 0 }, { startMs: 4000 }, { startMs: 9000 }];
  assert.equal(segmentIndexAt(segments, 5000), 1);
  assert.equal(segmentIndexAt(segments, -1), -1);
});

test("the recorder moves through its states and ignores events that do not apply", () => {
  let state = "idle";
  for (const [event, expected] of [["start", "countdown"], ["go", "recording"], ["pause", "paused"], ["resume", "recording"], ["stop", "saving"], ["done", "idle"]]) {
    state = nextRecorderState(state, event);
    assert.equal(state, expected);
  }
  assert.equal(nextRecorderState("idle", "stop"), "idle");
  assert.equal(nextRecorderState("countdown", "cancel"), "idle");
});

test("recorded time leaves out paused spans", () => {
  assert.equal(recordedMs({ startedAt: 1000 }, 6000), 5000);
  assert.equal(recordedMs({ startedAt: 1000, pausedTotal: 2000 }, 6000), 3000);
  assert.equal(recordedMs({ startedAt: 1000, pausedTotal: 1000, pausedAt: 4000 }, 9000), 2000);
  assert.equal(recordedMs({ startedAt: null }, 9000), 0);
});

test("the recorder picks the first container the browser supports", () => {
  const supports = (...types) => ({ isTypeSupported: (type) => types.includes(type) });
  assert.deepEqual(pickRecordingTypes(supports("video/webm", "audio/webm")), { video: "video/webm", audio: "audio/webm" });
  assert.deepEqual(pickRecordingTypes(supports("video/mp4")), { video: "video/mp4", audio: null });
  assert.deepEqual(pickRecordingTypes(undefined), { video: null, audio: null });
});

test("the viewers line counts people and finishers", () => {
  assert.equal(viewersSummary({ viewers: 0 }), "No views yet");
  assert.equal(viewersSummary({ viewers: 1, completed: 0 }), "1 person has watched");
  assert.equal(viewersSummary({ viewers: 3, completed: 2 }), "3 people have watched, 2 watched to the end");
});
