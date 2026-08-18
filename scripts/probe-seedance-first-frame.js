/**
 * Probe: does ModelArk's `role: "first_frame"` content item actually work,
 * and does it really constrain the new video to start from that image?
 *
 * ⚠ THIS COSTS TWO REAL, BILLED GENERATIONS. Not run automatically, nothing
 * in the app calls it.
 *
 *   npx tsx scripts/probe-seedance-first-frame.js
 *   npx tsx scripts/probe-seedance-first-frame.js --duration 5
 *
 * Why two generations, unlike the free n=99-style probes elsewhere in this
 * repo (probe-kling-image.js, probe-kling-seed.js): those work because an
 * out-of-range enum value is validated and rejected BEFORE a task is
 * created, so the "what does the server blame" trick costs nothing. There is
 * no equivalent free trick for `first_frame` — nothing about it fails
 * synchronous parameter validation, so the only way to learn whether it's a
 * real, honoured field is to actually run a generation and look at the
 * result.
 *
 * `role: "first_frame"` / `role: "last_frame"` are NOT confirmed against
 * BytePlus's own docs in this codebase — see providers/seedance.js's
 * createVideoTask header for the full evidence note (a third-party
 * tutorial with real executed code, not an official docs read or a prior
 * live probe against this app's own key). This script is what upgrades
 * that to "confirmed live", or tells you it doesn't work as expected.
 *
 * What it does:
 *   1. Generates a short, cheap text-to-video clip (the "shot 1" stand-in).
 *   2. Extracts its LAST frame server-side, via the same
 *      video-frame-server.js module Phase 3.2's best-of-N judging uses.
 *   3. Submits a SECOND task with that frame as `first_frame` and a new
 *      prompt describing a continuation action.
 *   4. Prints both video URLs so you can watch them back to back and
 *      confirm shot 2 visually starts where shot 1 left off.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createVideoTask, getVideoTask } from "../src/lib/providers/seedance";
import { extractLastFrameServer } from "../src/lib/video-frame-server";

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const duration = Number(value("duration", "4"));

async function pollToDone(taskId, label) {
  const started = Date.now();
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const st = await getVideoTask(taskId);
    if (st.status === "succeeded") {
      console.log(`${label}  succeeded in ${Math.round((Date.now() - started) / 1000)}s`);
      console.log(`${label}  url=${st.videoUrl}`);
      return st.videoUrl;
    }
    if (st.status === "failed") {
      console.log(`${label}  FAILED: ${st.error}`);
      return undefined;
    }
  }
  console.log(`${label}  timed out waiting`);
  return undefined;
}

async function main() {
  if (!process.env.ARK_API_KEY) {
    console.error("ARK_API_KEY is not set in .env.local — nothing to probe.");
    process.exit(1);
  }
  console.log(
    "This makes TWO REAL, BILLED generations. Ctrl-C within 5s to abort.\n" +
      `  duration=${duration}s, 480p, no reference images`
  );
  await new Promise((r) => setTimeout(r, 5000));

  console.log("\n── shot 1: ordinary text-to-video ─────────────────────────────");
  const shot1Task = await createVideoTask({
    prompt:
      "A lit candle burning steadily on a wooden table in a dim room, " +
      "static camera, slow gentle flicker.",
    modelDisplay: "Seedance 2.0",
    ratio: "16:9",
    resolution: "480p",
    duration,
  });
  console.log(`shot1  task=${shot1Task}`);
  const shot1Url = await pollToDone(shot1Task, "shot1");
  if (!shot1Url) {
    console.error("shot 1 did not succeed — aborting before spending on shot 2.");
    process.exit(1);
  }

  console.log("\n── extracting shot 1's last frame (server-side ffmpeg) ────────");
  const frame = await extractLastFrameServer(shot1Url);
  console.log(`extracted a ${frame.mimeType} frame, ${frame.data.length} base64 chars`);

  console.log("\n── shot 2: continuing from that frame via role:\"first_frame\" ──");
  const shot2Task = await createVideoTask({
    prompt:
      "A gust of wind blows through and extinguishes the candle, smoke " +
      "curling upward, camera stays static.",
    modelDisplay: "Seedance 2.0",
    ratio: "16:9",
    resolution: "480p",
    duration,
    firstFrame: { dataUrl: `data:${frame.mimeType};base64,${frame.data}` },
  });
  console.log(`shot2  task=${shot2Task}`);
  const shot2Url = await pollToDone(shot2Task, "shot2");

  console.log("\n── verdict ─────────────────────────────────────────────────");
  if (!shot2Url) {
    console.log(
      "shot 2 failed outright — either the `first_frame` role/shape is wrong, " +
        "or something else about the request was rejected. Check the error " +
        "above; do not assume this confirms first_frame doesn't exist without " +
        "reading the actual message."
    );
  } else {
    console.log(
      "Both shots succeeded. This does NOT by itself prove first_frame " +
        "constrained the output — a request with an unrecognised/ignored " +
        "role would also just succeed as an ordinary text-to-video. Watch " +
        "both videos back to back:\n" +
        `  shot1 (ends at a burning candle): ${shot1Url}\n` +
        `  shot2 (should OPEN on that same candle):     ${shot2Url}\n` +
        "If shot 2's opening frame visibly matches shot 1's ending frame, " +
        "first_frame is real and working — safe to rely on beyond this " +
        "probe. If shot 2 opens on something unrelated, first_frame is " +
        "being silently ignored and config.supportsFirstFrameContinuation " +
        "should be flipped back to false with a note recording this result."
    );
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
