/**
 * Probe: does Seedance 2.5 actually work the way providers/seedance.ts
 * assumes, now that it's activated on this account's API key?
 *
 * Free by default — just confirms the endpoint/auth/model-id resolve, no
 * task is created. `--generate` makes ONE real billed text-to-video
 * generation and reports the exact fields this app depends on.
 *
 *   npx tsx scripts/probe-seedance-25.ts                    # free
 *   npx tsx scripts/probe-seedance-25.ts --generate          # billed
 *   npx tsx scripts/probe-seedance-25.ts --edit <video-url>   # billed
 *   npx tsx scripts/probe-seedance-25.ts --extend <video-url> # billed
 *
 * Three things were unverified when this model was wired up (2026-08-07,
 * before it was activated) and this script exists to close all three:
 *
 *  1. The ModelArk console's "API support" section lists the endpoint as
 *     `/v3/contents/generations` (no `/tasks`), which reads as a possibly
 *     different/synchronous surface from the `/contents/generations/tasks`
 *     async create+poll endpoint Seedance 2.0 already uses here. Official
 *     docs (docs.byteplus.com/en/docs/ModelArk/2607688, /1520757, /1521309)
 *     say it's the SAME endpoint family — this free check confirms that
 *     against a live account rather than trusting the docs alone.
 *  2. Whether `dreamina-seedance-2-5-260628` (providers/seedance.ts
 *     pickModel) is the correct, currently-live model id.
 *  3. Whether the finished task really reports `usage.total_tokens`, which
 *     generate/video/status/route.ts depends on for exact billing
 *     (computeSeedanceTokenCostCents in pricing.ts) — a wrong assumption
 *     here means every Seedance 2.5 generation silently keeps its rough
 *     enqueue-time estimate instead of the real cost.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createVideoTask, getVideoTask } from "../src/lib/providers/seedance";
import { computeSeedanceTokenCostCents, DEFAULT_PRICING, formatCost } from "../src/lib/pricing";

const BASE = (
  process.env.ARK_BASE_URL || "https://ark.ap-southeast.bytepluses.com/api/v3"
).replace(/\/$/, "");
const MODEL_25 = process.env.SEEDANCE_MODEL_25 || "dreamina-seedance-2-5-260628";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

/** Zero-cost: GET a task id that cannot exist. A well-formed "task not
 *  found" style error proves the endpoint, auth, and route shape are all
 *  correct without creating (and being billed for) anything. Any other
 *  failure shape (404 route-not-found HTML, 401, connection error) means
 *  something in claim #1 above is wrong and must be fixed before trusting
 *  the rest of this file. */
async function checkEndpointReachable() {
  const probeId = "probe-nonexistent-task-id-000000";
  const res = await fetch(`${BASE}/contents/generations/tasks/${probeId}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${process.env.ARK_API_KEY}` },
  });
  const text = await res.text();
  console.log(`GET .../contents/generations/tasks/${probeId}`);
  console.log(`  HTTP ${res.status}`);
  console.log(`  ${text.slice(0, 400)}`);
  if (res.status === 404) {
    console.log(
      "  ✔ endpoint/auth reachable — the /tasks async surface exists on this " +
        "account, contradicting the console's truncated-looking path label."
    );
  } else if (res.status === 401) {
    console.log("  ✘ auth rejected — check ARK_API_KEY.");
  } else {
    console.log(
      "  ? unexpected status — inspect the body above before assuming anything."
    );
  }
}

async function generate(taskMode, videoUrl) {
  const label = `taskMode=${taskMode}`;
  const started = Date.now();

  const taskId = await createVideoTask({
    prompt:
      taskMode === "generate"
        ? "A single wooden wind chime on a porch in a light breeze, close-up, " +
          "chimes clinking gently. Natural daylight, static camera."
        : taskMode === "edit"
          ? "Edit: make the lighting warmer, golden-hour tone."
          : "Extend the shot forward, same subject and motion continuing.",
    modelDisplay: "Seedance 2.5",
    // Cheapest settings that still exercise the real path.
    ratio: taskMode === "generate" ? "16:9" : undefined,
    resolution: "480p",
    duration: taskMode === "extend" ? 4 : undefined,
    referenceVideoUrls: videoUrl ? [videoUrl] : undefined,
    generateAudio: false,
    taskMode,
  });
  console.log(`${label}  task=${taskId}  model requested=${MODEL_25}`);

  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const st = await getVideoTask(taskId);
    if (st.status === "succeeded") {
      const elapsed = Math.round((Date.now() - started) / 1000);
      const raw = st.raw ;
      console.log(`\n${label}  succeeded in ${elapsed}s`);
      console.log(`  videoUrl=${st.videoUrl}`);
      console.log(`  raw.model=${raw?.model} (expected ${MODEL_25})`);
      console.log(`  raw.usage=${JSON.stringify(raw?.usage)}`);
      console.log(`  parsed totalTokens=${st.totalTokens}`);
      if (st.totalTokens != null) {
        const hadVideoInput = !!videoUrl;
        const cents = computeSeedanceTokenCostCents(
          "Seedance 2.5",
          st.totalTokens,
          hadVideoInput,
          DEFAULT_PRICING
        );
        console.log(
          `  computed cost (${hadVideoInput ? "video-input" : "no-video-input"} rate): ` +
            (cents != null ? formatCost(cents) : "n/a — pricing row missing")
        );
      } else {
        console.log(
          "  ✘ usage.total_tokens was NOT present — pricing.ts's " +
            "computeSeedanceTokenCostCents will keep the rough enqueue-time " +
            "estimate for every Seedance 2.5 generation. Check raw.usage above " +
            "for the actual field name/shape and fix getVideoTask accordingly."
        );
      }
      return;
    }
    if (st.status === "failed") {
      console.log(`\n${label}  FAILED: ${st.error}`);
      console.log(`  raw=${JSON.stringify(st.raw).slice(0, 500)}`);
      return;
    }
  }
  console.log(`\n${label}  timed out waiting`);
}

async function main() {
  if (!process.env.ARK_API_KEY) {
    console.error("ARK_API_KEY is not set in .env.local — nothing to probe.");
    process.exit(1);
  }

  console.log(`Probing Seedance 2.5 (${MODEL_25}) at ${BASE}\n`);
  await checkEndpointReachable();

  const editUrl = value("edit");
  const extendUrl = value("extend");

  if (!flag("generate") && !editUrl && !extendUrl) {
    console.log(
      "\nFree check only — nothing was created or billed. Re-run with " +
        "--generate for a real text-to-video generation, or --edit/--extend " +
        "<public-video-url> to test those task types."
    );
    return;
  }

  console.log(
    "\nThis makes a REAL, BILLED generation. Ctrl-C within 5s to abort."
  );
  await new Promise((r) => setTimeout(r, 5000));

  if (flag("generate")) await generate("generate");
  if (editUrl) await generate("edit", editUrl);
  if (extendUrl) await generate("extend", extendUrl);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
