/**
 * Probe whether Kling's image API recognises a `seed` request parameter.
 *
 * Phase 3.1 (reproducibility seed) wired seed into Gemini/NBP and native
 * BytePlus Seedance, both confirmed via docs/live checks this session, but
 * deliberately left Kling out of config.supportsSeed — Kling's own API
 * reference for `/v1/images/generations` does not list a `seed` field, and a
 * third-party aggregator's schema for the same endpoint agrees, but neither
 * is strong enough evidence either way (see config.js's doc comment). This
 * script settles it against the live endpoint before anyone flips that flag.
 *
 * DEFAULT RUN IS FREE, same trick probe-kling-image.js uses: every request
 * carries n=99 against a documented max of 9, so validation always fails
 * before a task is ever created — we only read which field Kling blames.
 *
 *   npx tsx scripts/probe-kling-seed.js
 *
 * There is no --generate mode for this probe. If the free checks below are
 * inconclusive, the only way to fully confirm `seed` actually constrains
 * output is two real generations with the same seed and a diff of the
 * results — that costs two billed images and is a manual follow-up, not
 * something to automate here.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { KLING_MODELS } from "../src/lib/providers/kling";

const HOST = (process.env.KLING_API_HOST || "https://api-singapore.klingai.com").replace(/\/$/, "");
const KEY = process.env.KLING_API;

let failures = 0;
function check(label, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}

async function call(path, init) {
  const res = await fetch(`${HOST}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text.slice(0, 200) };
  }
  return { status: res.status, json };
}

async function main() {
  if (!KEY) {
    console.error("KLING_API is not set in .env.local");
    process.exit(1);
  }
  if (!/^https?:\/\//.test(HOST)) {
    console.error(
      `KLING_API_HOST is not a URL (got ${JSON.stringify(HOST)}).\n` +
        `This .env.local looks scrubbed — run this where the real Kling ` +
        `credentials are, or unset KLING_API_HOST to use the default.`
    );
    process.exit(1);
  }
  console.log(`host: ${HOST}\n`);

  const model = KLING_MODELS[0]?.modelName ?? "kling-v3";

  // ── 1. baseline: n=99 alone, no seed ────────────────────────────────────
  console.log("── baseline (no seed) ─────────────────────────────────────────");
  const baseline = await call("/v1/images/generations", {
    method: "POST",
    body: JSON.stringify({ model_name: model, prompt: "a red bicycle", n: 99 }),
  });
  const baselineMsg = String(baseline.json?.message ?? "");
  check(
    "n=99 is rejected server-side (control case, no task created)",
    baseline.json?.code !== 0,
    `http=${baseline.status} code=${baseline.json?.code} message=${baselineMsg.slice(0, 100)}`
  );
  const baselineBlamesN = /\bn\b/i.test(baselineMsg);
  console.log(`      baseline error mentions "n": ${baselineBlamesN}`);

  // ── 2. n=99 + a plausible integer seed ──────────────────────────────────
  // If Kling's schema doesn't know `seed` at all, this should produce the
  // SAME error as the baseline (unknown fields are typically ignored, not
  // rejected, by REST APIs that don't do strict schema validation). If the
  // error changes to blame `seed` specifically, that's real evidence the
  // field is recognised.
  console.log("\n── n=99 + seed=12345 (int) ────────────────────────────────────");
  const withSeed = await call("/v1/images/generations", {
    method: "POST",
    body: JSON.stringify({ model_name: model, prompt: "a red bicycle", n: 99, seed: 12345 }),
  });
  const withSeedMsg = String(withSeed.json?.message ?? "");
  const blamesSeed = /seed/i.test(withSeedMsg);
  console.log(
    `      http=${withSeed.status} code=${withSeed.json?.code} message=${withSeedMsg.slice(0, 100)}`
  );
  console.log(`      error mentions "seed": ${blamesSeed}`);
  console.log(
    `      error identical to baseline: ${withSeedMsg === baselineMsg}`
  );

  // ── 3. n=99 + an invalid-type seed (string where a number is expected) ──
  // The strongest free signal available: if Kling's validator processes
  // `seed` at all, a wrong-typed value should draw its own complaint. An
  // identical-to-baseline result here means either the field is silently
  // ignored (not a real parameter) or the validator doesn't type-check it
  // before bailing on `n` first — inconclusive on its own, but combined with
  // check 2 gives a fuller picture.
  console.log("\n── n=99 + seed=\"not-a-number\" (invalid type) ─────────────────");
  const badSeed = await call("/v1/images/generations", {
    method: "POST",
    body: JSON.stringify({ model_name: model, prompt: "a red bicycle", n: 99, seed: "not-a-number" }),
  });
  const badSeedMsg = String(badSeed.json?.message ?? "");
  const badSeedBlamesSeed = /seed/i.test(badSeedMsg);
  console.log(
    `      http=${badSeed.status} code=${badSeed.json?.code} message=${badSeedMsg.slice(0, 100)}`
  );
  console.log(`      error mentions "seed": ${badSeedBlamesSeed}`);

  console.log("\n── verdict ─────────────────────────────────────────────────");
  if (blamesSeed || badSeedBlamesSeed) {
    console.log(
      "Kling's validator explicitly reacted to `seed` — real evidence the field " +
        "exists on this endpoint. Safe to extend config.supportsSeed to Kling, " +
        "but still confirm determinism with two real same-seed generations before " +
        "presenting it as reproducible to users."
    );
  } else if (withSeedMsg === baselineMsg && badSeedMsg === baselineMsg) {
    console.log(
      "No signal either way — `seed` produced byte-identical errors to the " +
        "baseline in both the valid- and invalid-type cases, consistent with the " +
        "field being silently ignored (unknown parameter) rather than accepted. " +
        "Do not flip config.supportsSeed on this evidence alone."
    );
  } else {
    console.log(
      "Mixed signal — read the raw messages above by hand before drawing a " +
        "conclusion; this script does not have a confident verdict for this case."
    );
  }

  console.log(`\n${failures === 0 ? "all checks passed" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
