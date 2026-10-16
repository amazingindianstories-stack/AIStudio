import test from "node:test";
import assert from "node:assert/strict";
import { measureAudioDuration, referenceAudioProblem, withAudioDurations } from "./audio-duration";
import { referenceAudioLimits } from "./config";

const notes = (...durations) => durations.map((duration, i) => ({ name: `clip-${i}.mp3`, ref: `/api/media/uploads/audio-reference/${i}`, duration }));

test("registry carries the BytePlus audio limits for direct Seedance models only", () => {
  assert.deepEqual(referenceAudioLimits("Seedance 2.5"), { clipMin: 2, clipMax: 30, totalMax: 30 });
  assert.deepEqual(referenceAudioLimits("Seedance 2.0"), { clipMin: 2, clipMax: 15, totalMax: 15 });
  assert.deepEqual(referenceAudioLimits("Seedance 2.0 Mini"), { clipMin: 2, clipMax: 15, totalMax: 15 });
  assert.equal(referenceAudioLimits("Higgsfield Seedance 2.0"), null);
});

test("an over-long clip is named with its length and the model's rule", () => {
  const problem = referenceAudioProblem("Seedance 2.5", notes(12, 34.6));
  assert.deepEqual(problem.indexes, [1]);
  assert.equal(problem.message, "@audio2 is 34.6s long. Seedance 2.5 accepts reference audio clips of 2-30s each and 30s in total. Trim it before generating.");
  assert.match(referenceAudioProblem("Seedance 2.0", notes(16)).message, /^@audio1 is 16\.0s long\. Seedance 2\.0 accepts reference audio clips of 2-15s/);
});

test("too-short clips and the per-request total are refused", () => {
  assert.match(referenceAudioProblem("Seedance 2.5", notes(1.2)).message, /^@audio1 is only 1\.2s long/);
  const total = referenceAudioProblem("Seedance 2.5", notes(20, 20));
  assert.deepEqual(total.indexes, []);
  assert.match(total.message, /^The reference audio adds up to 40\.0s\./);
});

test("clips inside the limits, the provider tolerance or of unknown length pass", () => {
  assert.equal(referenceAudioProblem("Seedance 2.5", notes(30.15)), null);
  assert.equal(referenceAudioProblem("Seedance 2.5", notes(2, 28)), null);
  assert.equal(referenceAudioProblem("Seedance 2.5", notes(25, undefined, 25)), null);
  assert.equal(referenceAudioProblem("Seedance 2.5", [{ name: "legacy.mp3", ref: "x" }]), null);
  assert.equal(referenceAudioProblem("Higgsfield Seedance 2.0", notes(60)), null);
  assert.equal(referenceAudioProblem("Seedance 2.5", []), null);
});

test("measuring outside a browser reports an unknown length", async () => {
  assert.equal(await measureAudioDuration("/api/media/uploads/audio-reference/x"), null);
});

test("restored notes get their length measured; measured and legacy notes are kept", async () => {
  const measured = { name: "a.mp3", ref: "/a", duration: 12 };
  const restored = { name: "Audio 2", ref: "/b" };
  const unknown = { name: "Audio 3", ref: "/c" };
  const lengths = { "/b": 34.6, "/c": null };
  const calls = [];
  const out = await withAudioDurations([measured, restored, unknown, "legacy.mp3"], async (ref) => { calls.push(ref); return lengths[ref]; });
  assert.deepEqual(calls, ["/b", "/c"]);
  assert.equal(out[0], measured);
  assert.deepEqual(out[1], { name: "Audio 2", ref: "/b", duration: 34.6 });
  assert.equal(out[2], unknown);
  assert.equal(out[3], "legacy.mp3");
  const untouched = [measured];
  assert.equal(await withAudioDurations(untouched, async () => assert.fail("must not measure")), untouched);
});
