/**
 * Fixture-driven face-identity regression harness (Phase 3.4).
 *
 * Turns ab-face-eval.js (a one-off, hardcoded A/B bake-off against a single
 * live database row, used for the July 2026 Higgsfield-parity research) into
 * a repeatable regression check: for each committed fixture, run the CURRENT
 * production image pipeline (assemblePrompt → generateImageGemini) N times,
 * judge each result with middleware/face-judge.js's judgeCandidate — the
 * SAME judge best-of-N uses in production, not a separate scorer — and
 * compare the average identity score against a recorded floor. A meaningful
 * drop means something in prompt-assembler.js / gemini.js / face-judge.js
 * regressed identity locking, which is exactly the class of change this
 * repo's own bake-off research (see .council/higgsfield-nbp-parity/) has
 * shown is easy to get wrong silently.
 *
 * ⚠ NOT WIRED INTO CI, AND NOT RUN AUTOMATICALLY BY ANYTHING. Two independent
 * reasons, both hard blockers on this repo specifically:
 *   1. Every run makes real, billed Nano Banana Pro generations (`samples`
 *      per fixture). This repo has NO CI pipeline today (no
 *      .github/workflows/), and auto-running billed API calls on every push
 *      to a PUBLIC repo means anyone who opens a PR can trigger real
 *      charges — the same reasoning every other live-API probe script here
 *      (probe-seedance-audio.js, probe-kling-image.js's --generate mode,
 *      etc.) is manual-only.
 *   2. Face-identity fixtures need real reference photos to mean anything,
 *      and this repo is public — committing real people's faces to public
 *      git history isn't done here regardless of consent. Fixtures and
 *      their images live in scripts/eval-fixtures/, gitignored except the
 *      README and an empty example template. See that README for setup.
 * This deviates from the original plan's "gated in CI" phrasing — discussed
 * and confirmed with the repo owner before building it this way, rather
 * than silently narrowing the scope.
 *
 * Usage:
 *   npm run eval:regression                  # run all fixtures, fail on regression
 *   npm run eval:regression -- --update-floors  # (re)establish this run's
 *                                                # average as each fixture's
 *                                                # new floor instead of
 *                                                # comparing against one
 *   npm run eval:regression -- --fixture=example  # run just one fixture
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { promises as fs } from "node:fs";
import path from "node:path";
import { assemblePrompt } from "../src/lib/prompt-assembler";
import { prepReference, identityCrops } from "../src/lib/middleware/image-prep";
import { generateImageGemini } from "../src/lib/providers/gemini";
import { judgeCandidate } from "../src/lib/middleware/face-judge";

const FIXTURES_DIR = path.join(process.cwd(), "scripts", "eval-fixtures");
const RESULTS_DIR = path.join(process.cwd(), "scripts", "eval-results");

const args = process.argv.slice(2);
const updateFloors = args.includes("--update-floors");
const onlyFixture = args.find((a) => a.startsWith("--fixture="))?.split("=")[1];

// A drop bigger than this (in identity points, 0-100 scale) below the
// recorded floor fails the run. Generation is stochastic — a few points of
// run-to-run noise is expected and not itself a regression; this is set
// loosely on purpose (tighten it once real fixtures establish how noisy a
// given prompt/reference actually is in practice).
const REGRESSION_TOLERANCE = 10;

function extFromPath(p) {
  const e = path.extname(p).toLowerCase();
  if (e === ".webp") return "image/webp";
  if (e === ".jpg" || e === ".jpeg") return "image/jpeg";
  return "image/png";
}

async function loadFixtures() {
  let files;
  try {
    files = await fs.readdir(FIXTURES_DIR);
  } catch {
    return [];
  }
  const fixtures = [];
  for (const f of files) {
    if (!f.endsWith(".fixture.json")) continue;
    if (f === "example.fixture.json") continue; // template only, never a real fixture to run
    const name = f.replace(/\.fixture\.json$/, "");
    if (onlyFixture && name !== onlyFixture) continue;
    const raw = await fs.readFile(path.join(FIXTURES_DIR, f), "utf8");
    fixtures.push({ file: f, ...JSON.parse(raw) });
  }
  return fixtures;
}

async function runFixture(fixture) {
  const refDataUrls = [];
  const rawRefs = [];
  for (const refPath of fixture.referenceImages ?? []) {
    const resolved = path.isAbsolute(refPath) ? refPath : path.join(FIXTURES_DIR, refPath);
    const buf = await fs.readFile(resolved);
    const prepped = await prepReference(extFromPath(resolved), buf.toString("base64"));
    rawRefs.push(prepped);
    refDataUrls.push(`data:${prepped.mimeType};base64,${prepped.data}`);
  }
  if (!rawRefs.length) {
    throw new Error(`fixture "${fixture.name}" has no reference images to judge identity against`);
  }

  const assembled = await assemblePrompt(fixture.prompt, [], refDataUrls, {
    aspectRatio: fixture.aspectRatio,
  });
  // Same ground-truth-face convention ab-face-eval.js used: a tight identity
  // crop of the FIRST reference image, falling back to the raw reference if
  // no face is detected in it (a location/style-only fixture, unlikely but
  // not worth hard-erroring on).
  const refFace = (await identityCrops(rawRefs[0].mimeType, rawRefs[0].data, 1))[0] || rawRefs[0];

  const samples = Math.max(1, Number(fixture.samples) || 3);
  const scores = [];
  for (let i = 1; i <= samples; i++) {
    const t0 = Date.now();
    try {
      const result = await generateImageGemini({
        assembled,
        aspectRatio: fixture.aspectRatio,
        imageSize: fixture.resolution,
        modelDisplay: fixture.model,
      });
      const score = await judgeCandidate(refFace, { mimeType: result.mimeType, data: result.base64 });
      const identity = score?.identity ?? -1;
      scores.push(identity);
      console.log(
        `  [${fixture.name}] sample ${i}/${samples}: identity=${identity} ` +
          `prominence=${score?.prominence ?? "n/a"} sharpness=${score?.sharpness ?? "n/a"} ` +
          `(${Math.round((Date.now() - t0) / 1000)}s)`
      );
    } catch (e) {
      scores.push(-1);
      console.log(`  [${fixture.name}] sample ${i}/${samples}: ERROR ${e?.message?.slice(0, 200)}`);
    }
  }

  const valid = scores.filter((s) => s >= 0);
  const average = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : -1;
  return { scores, average, sampleCount: samples, validCount: valid.length };
}

async function main() {
  if (!process.env.GOOGLE_API_KEY) {
    console.error("GOOGLE_API_KEY is not set in .env.local — nothing to run.");
    process.exit(1);
  }
  const fixtures = await loadFixtures();
  if (!fixtures.length) {
    console.log(
      "No fixtures found in scripts/eval-fixtures/ (only example.fixture.json exists, " +
        "which is a template, never run). See that directory's README.md to set one up."
    );
    return;
  }

  const totalSamples = fixtures.reduce((n, f) => n + Math.max(1, Number(f.samples) || 3), 0);
  console.log(
    `This makes ${totalSamples} REAL, BILLED generations across ${fixtures.length} fixture(s). ` +
      "Ctrl-C within 5s to abort.\n" +
      (updateFloors ? "  mode: --update-floors (will overwrite recorded floors)" : "  mode: check against recorded floors")
  );
  await new Promise((r) => setTimeout(r, 5000));

  await fs.mkdir(RESULTS_DIR, { recursive: true });
  const report = [];
  let anyFailed = false;

  for (const fixture of fixtures) {
    console.log(`\n── ${fixture.name} ─────────────────────────────────────────────`);
    let result;
    try {
      result = await runFixture(fixture);
    } catch (e) {
      console.log(`  FIXTURE ERROR: ${e?.message}`);
      anyFailed = true;
      report.push({ name: fixture.name, error: e?.message });
      continue;
    }

    const floor = fixture.identityFloor;
    let status;
    if (updateFloors) {
      status = "FLOOR UPDATED";
      fixture.identityFloor = Math.round(result.average * 10) / 10;
      await fs.writeFile(
        path.join(FIXTURES_DIR, fixture.file),
        JSON.stringify(
          {
            name: fixture.name,
            prompt: fixture.prompt,
            referenceImages: fixture.referenceImages,
            aspectRatio: fixture.aspectRatio,
            resolution: fixture.resolution,
            model: fixture.model,
            samples: fixture.samples,
            identityFloor: fixture.identityFloor,
          },
          null,
          2
        ) + "\n"
      );
    } else if (floor == null) {
      status = "NO FLOOR RECORDED — run with --update-floors first";
    } else if (result.average < floor - REGRESSION_TOLERANCE) {
      status = `REGRESSION (avg ${result.average.toFixed(1)} < floor ${floor} - ${REGRESSION_TOLERANCE})`;
      anyFailed = true;
    } else {
      status = `OK (avg ${result.average.toFixed(1)}, floor ${floor})`;
    }
    console.log(`  → ${status}`);
    report.push({ name: fixture.name, ...result, floor, status });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(RESULTS_DIR, `${stamp}.json`);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nFull report: ${reportPath}`);

  if (anyFailed && !updateFloors) {
    console.log("\nOne or more fixtures regressed or errored — see above.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("HARNESS FAILED:", e);
  process.exit(1);
});
