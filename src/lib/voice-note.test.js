import test from "node:test";
import assert from "node:assert/strict";
import { insertTranscript, MIN_VOICE_MS, startVoiceNote, transcribeVoiceNote, voiceCaps, voiceErrorMessage, VoiceNoteError } from "./voice-note.js";

function fakeTimers() {
  const timers = { intervals: new Map(), timeouts: new Map(), next: 1 };
  timers.setInterval = (fn, ms) => { timers.intervals.set(timers.next, { fn, ms }); return timers.next++; };
  timers.clearInterval = (id) => timers.intervals.delete(id);
  timers.setTimeout = (fn, ms) => { timers.timeouts.set(timers.next, { fn, ms }); return timers.next++; };
  timers.clearTimeout = (id) => timers.timeouts.delete(id);
  timers.fireTimeouts = () => [...timers.timeouts.values()].forEach(({ fn }) => fn());
  timers.tick = () => [...timers.intervals.values()].forEach(({ fn }) => fn());
  return timers;
}

function fakeMic({ supported = ["audio/webm;codecs=opus"], deny } = {}) {
  const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  const stream = { getTracks: () => tracks };
  const created = [];
  class Recorder {
    static isTypeSupported(type) { return supported.includes(type); }
    constructor(source, options) {
      assert.equal(source, stream);
      this.options = options;
      this.mimeType = options?.mimeType || "audio/mp4";
      this.state = "inactive";
      created.push(this);
    }
    start(timeslice) { this.timeslice = timeslice; this.state = "recording"; }
    stop() {
      this.state = "inactive";
      this.ondataavailable({ data: new Blob(["voice"], { type: this.mimeType }) });
      this.onstop();
    }
  }
  const asked = [];
  const mediaDevices = { getUserMedia: async (constraints) => { asked.push(constraints); if (deny) throw deny; return stream; } };
  return { mediaDevices, Recorder, created, tracks, asked };
}

const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test("records the preferred audio type, reports elapsed time and returns the blob with its duration on stop", async () => {
  const mic = fakeMic();
  const timers = fakeTimers();
  let clock = 1000;
  const ticks = [];
  const note = await startVoiceNote({ maxMs: 120000, onTick: (ms) => ticks.push(ms), mediaDevices: mic.mediaDevices,
    MediaRecorderImpl: mic.Recorder, now: () => clock, timers });
  assert.deepEqual(mic.asked, [{ audio: true }]);
  assert.deepEqual(mic.created[0].options, { mimeType: "audio/webm;codecs=opus" });
  assert.equal(mic.created[0].timeslice, 1000);
  assert.equal([...timers.timeouts.values()][0].ms, 120000);
  clock = 4200;
  timers.tick();
  note.stop();
  note.stop();
  const result = await note.done;
  assert.deepEqual(ticks, [0, 3200]);
  assert.equal(result.durationMs, 3200);
  assert.equal(result.blob.type, "audio/webm;codecs=opus");
  assert.equal(await result.blob.text(), "voice");
  assert.equal(mic.tracks[0].stopped, true);
  assert.equal(timers.intervals.size + timers.timeouts.size, 0);
});

test("stops itself at the voice limit and reports no more than the limit", async () => {
  const mic = fakeMic({ supported: ["audio/mp4"] });
  const timers = fakeTimers();
  let clock = 0;
  const note = await startVoiceNote({ maxMs: 120000, mediaDevices: mic.mediaDevices, MediaRecorderImpl: mic.Recorder, now: () => clock, timers });
  assert.deepEqual(mic.created[0].options, { mimeType: "audio/mp4" });
  clock = 120400;
  timers.fireTimeouts();
  const result = await note.done;
  assert.equal(result.durationMs, 120000);
  assert.equal(mic.created[0].state, "inactive");
  assert.equal(mic.tracks[0].stopped, true);
});

test("cancel resolves to null and a mis-tap is refused as too short", async () => {
  const mic = fakeMic();
  let clock = 0;
  const cancelled = await startVoiceNote({ maxMs: 5000, mediaDevices: mic.mediaDevices, MediaRecorderImpl: mic.Recorder, now: () => clock, timers: fakeTimers() });
  cancelled.cancel();
  assert.equal(await cancelled.done, null);
  const short = await startVoiceNote({ maxMs: 5000, mediaDevices: mic.mediaDevices, MediaRecorderImpl: mic.Recorder, now: () => clock, timers: fakeTimers() });
  clock = MIN_VOICE_MS - 1;
  short.stop();
  await assert.rejects(short.done, (error) => error instanceof VoiceNoteError && error.code === "short");
});

test("an unsupported browser and a denied permission give clear errors and leave no microphone open", async () => {
  await assert.rejects(startVoiceNote({ maxMs: 1000, mediaDevices: undefined, MediaRecorderImpl: fakeMic().Recorder }),
    (error) => error.code === "unsupported" && /cannot record audio/.test(voiceErrorMessage(error)));
  await assert.rejects(startVoiceNote({ maxMs: 1000, mediaDevices: fakeMic().mediaDevices, MediaRecorderImpl: undefined }),
    (error) => error.code === "unsupported");
  const denied = Object.assign(new Error("denied"), { name: "NotAllowedError" });
  await assert.rejects(startVoiceNote({ maxMs: 1000, mediaDevices: fakeMic({ deny: denied }).mediaDevices, MediaRecorderImpl: fakeMic().Recorder }),
    (error) => error === denied);
  assert.match(voiceErrorMessage(denied), /^Microphone access is blocked\./);
  assert.match(voiceErrorMessage({ name: "NotFoundError" }), /^No microphone was found\./);
  assert.match(voiceErrorMessage({ name: "NotReadableError" }), /in use by another app/);
  assert.equal(voiceErrorMessage(new Error("x")), "Recording failed. Try again.");
  const broken = fakeMic();
  class Throwing extends broken.Recorder { constructor() { throw new Error("no codec"); } }
  await assert.rejects(startVoiceNote({ maxMs: 1000, mediaDevices: broken.mediaDevices, MediaRecorderImpl: Throwing }), (error) => error.code === "unsupported");
  assert.equal(broken.tracks[0].stopped, true);
  const refused = fakeMic();
  class NoStart extends refused.Recorder { start() { throw Object.assign(new Error("no"), { name: "NotSupportedError" }); } }
  await assert.rejects(startVoiceNote({ maxMs: 1000, mediaDevices: refused.mediaDevices, MediaRecorderImpl: NoStart }), (error) => error.code === "unsupported");
  assert.equal(refused.tracks[0].stopped, true);
});

test("reads the caps from the conversation's transcribe endpoint", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push([url, options]); return response(200, { maxSeconds: 120, maxBytes: 4194304 }); };
  assert.deepEqual(await voiceCaps("c 1", { fetchImpl }), { maxSeconds: 120, maxBytes: 4194304 });
  assert.deepEqual(calls, [["/api/agent-conversations/c%201/transcribe", { credentials: "same-origin", cache: "no-store" }]]);
  await assert.rejects(voiceCaps("c", { fetchImpl: async () => response(403, { error: "FORBIDDEN" }) }),
    (error) => error.code === "caps" && error.message === "You don't have permission to do that.");
  await assert.rejects(voiceCaps("c", { fetchImpl: async () => response(200, {}) }), (error) => error.code === "caps");
  await assert.rejects(voiceCaps("c", { fetchImpl: async () => { throw new TypeError("Failed to fetch"); } }),
    (error) => error.code === "caps" && /could not be reached/.test(voiceErrorMessage(error)));
});

test("posts the raw recording with its own type and duration and returns the transcript", async () => {
  const calls = [];
  const blob = new Blob(["voice"], { type: "audio/webm;codecs=opus" });
  const fetchImpl = async (url, options) => { calls.push([url, options]); return response(200, { transcript: "नमस्ते, make it warmer" }); };
  assert.equal(await transcribeVoiceNote("c1", { blob, durationMs: 3200.4 }, { maxBytes: 4194304, fetchImpl }), "नमस्ते, make it warmer");
  assert.deepEqual(calls, [["/api/agent-conversations/c1/transcribe?durationMs=3200", {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "audio/webm;codecs=opus" }, body: blob }]]);
});

test("a recording over the byte cap is refused before upload and a failed transcription says why", async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return response(200, { transcript: "" }); };
  await assert.rejects(transcribeVoiceNote("c1", { blob: new Blob(["12345"]), durationMs: 1000 }, { maxBytes: 4, fetchImpl }),
    (error) => error.code === "large");
  assert.equal(called, false);
  const blob = new Blob(["voice"], { type: "audio/mp4" });
  await assert.rejects(transcribeVoiceNote("c1", { blob, durationMs: 1000 }, { fetchImpl: async () => response(503, { error: "Voice input is not configured: GOOGLE_API_KEY is not set. Ask a Veevee admin." }) }),
    (error) => error.code === "transcribe" && /GOOGLE_API_KEY is not set/.test(error.message));
  await assert.rejects(transcribeVoiceNote("c1", { blob, durationMs: 1000 }, { fetchImpl: async () => response(502, {}) }),
    (error) => error.code === "transcribe");
  await assert.rejects(transcribeVoiceNote("c1", { blob, durationMs: 1000 }, { fetchImpl: async () => response(200, {}) }),
    (error) => error.code === "transcribe");
  await assert.rejects(transcribeVoiceNote("c1", { blob, durationMs: 1000 }, { fetchImpl: async () => { throw new TypeError("Failed to fetch"); } }),
    (error) => error.code === "transcribe" && /could not be reached to transcribe/.test(voiceErrorMessage(error)));
});

test("the transcript is appended to the draft for review, never replacing it", () => {
  assert.equal(insertTranscript("", "  hello  "), "hello");
  assert.equal(insertTranscript("Make a poster", "with a red sky"), "Make a poster with a red sky");
  assert.equal(insertTranscript("Line one\n", "line two"), "Line one\nline two");
  assert.equal(insertTranscript("Keep this", "   "), "Keep this");
});
