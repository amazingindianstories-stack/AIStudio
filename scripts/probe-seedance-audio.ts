/**
 * Probe: does ModelArk actually honour `generate_audio: true`, and does the
 * returned video carry an audio track?
 *
 * ⚠ THIS COSTS A REAL GENERATION. It is not run automatically and nothing in
 * the app calls it. Defaults are the cheapest settings that still exercise the
 * path (fast SKU, 480p, 4s, no reference images).
 *
 *   npx tsx scripts/probe-seedance-audio.ts
 *   npx tsx scripts/probe-seedance-audio.ts --standard --duration 5
 *
 * The repo's convention is that provider payload changes are backed by docs or
 * an empirical probe. `generate_audio` is documented as a top-level boolean on
 * the create-task payload (BytePlus Seedance 2.0), but two things only a real
 * call can answer: whether the account's model actually accepts it, and whether
 * the delivered MP4 has an audio stream. This answers both.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createVideoTask, getVideoTask } from "../src/lib/providers/seedance";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

async function run(generateAudio: boolean) {
  const label = generateAudio ? "generate_audio=true " : "generate_audio=false";
  const started = Date.now();

  const taskId = await createVideoTask({
    prompt:
      "A single wooden wind chime on a porch in a light breeze, close-up, " +
      "chimes clinking gently. Natural daylight, static camera.",
    // The fast SKU unless --standard: this is a billable call.
    modelDisplay: flag("standard") ? "Seedance 2.0" : "Seedance 2.0 Mini",
    ratio: "16:9",
    resolution: value("resolution", "480p"),
    duration: Number(value("duration", "4")),
    generateAudio,
  });
  console.log(`${label}  task=${taskId}`);

  // Poll to completion.
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const st = await getVideoTask(taskId);
    if (st.status === "succeeded") {
      console.log(
        `${label}  succeeded in ${Math.round((Date.now() - started) / 1000)}s`
      );
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
    "This makes a REAL, BILLED generation. Ctrl-C within 5s to abort.\n" +
      `  model=${flag("standard") ? "standard" : "fast/mini"} ` +
      `resolution=${value("resolution", "480p")} duration=${value("duration", "4")}s`
  );
  await new Promise((r) => setTimeout(r, 5000));

  const url = await run(true);

  console.log("\nTo confirm the file actually carries an audio stream:");
  if (url) {
    console.log(`  curl -sL "${url}" -o /tmp/seedance-audio.mp4`);
    console.log(`  ffprobe -v error -select_streams a -show_entries stream=codec_name,channels -of csv /tmp/seedance-audio.mp4`);
    console.log("  (any output = an audio stream is present; empty = video only)");
  }
  console.log(
    "\nAlso check the ModelArk console's usage page: if audio is billed as a " +
      "separate line item, the `Seedance 2.0` pricing row in the admin Pricing " +
      "tab under-reads the true cost of an audio generation."
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
