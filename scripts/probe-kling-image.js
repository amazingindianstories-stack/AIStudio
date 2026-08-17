/**
 * Probe Kling's image API and check our understanding of its contract.
 *
 * Kling's docs are a JS-rendered SPA that answers plain fetchers with HTTP 446,
 * so re-reading them needs a headless browser. This script is the cheaper way to
 * re-verify what providers/kling.ts assumes.
 *
 * DEFAULT RUN IS FREE. It only:
 *   - lists tasks (read-only) to prove the key and auth scheme work
 *   - builds payloads through buildKlingPayload to show the parameter gating
 *   - sends deliberately INVALID requests, which are rejected before a task is
 *     created and therefore cost nothing
 *
 *   npx tsx scripts/probe-kling-image.ts
 *
 * With --generate it additionally creates ONE real 1K text-to-image task, which
 * IS BILLED (~$0.014 on Kling Image 2.1). Never run that from an automated path.
 *
 *   npx tsx scripts/probe-kling-image.ts --generate
 */
import sharp from "sharp";
import { config } from "dotenv";
config({ path: ".env.local" });

import {
  KLING_MODELS,
  KLING_PROMPT_MAX,
  buildKlingPayload,
  generateImageKling,
  isKlingModel,
  klingSpec,
} from "../src/lib/providers/kling";

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
  // Some checkouts carry a scrubbed .env.local whose values are the literal
  // string "[SENSITIVE]". Without this, the first fetch dies on an unhelpful
  // "Failed to parse URL from [SENSITIVE]/v1/..." instead of saying what is
  // actually wrong.
  if (!/^https?:\/\//.test(HOST)) {
    console.error(
      `KLING_API_HOST is not a URL (got ${JSON.stringify(HOST)}).\n` +
        `This .env.local looks scrubbed — run this where the real Kling ` +
        `credentials are, or unset KLING_API_HOST to use the default.`
    );
    process.exit(1);
  }
  console.log(`host: ${HOST}\n`);

  // ── 1. auth scheme: a plain API key as a Bearer token, no JWT signing ──────
  console.log("── auth (read-only) ──────────────────────────────────────────");
  const list = await call("/v1/images/generations?pageNum=1&pageSize=1");
  check(
    "plain API key is accepted as a Bearer token",
    list.status === 200 && list.json?.code === 0,
    `http=${list.status} code=${list.json?.code} message=${list.json?.message}`
  );

  const noAuth = await fetch(`${HOST}/v1/images/generations?pageNum=1&pageSize=1`);
  check("the endpoint is not open without the key", noAuth.status !== 200, `http=${noAuth.status}`);

  // ── 2. model naming ───────────────────────────────────────────────────────
  console.log("\n── model mapping ─────────────────────────────────────────────");
  for (const m of KLING_MODELS) {
    check(`${m.display} → ${m.modelName}`, klingSpec(m.display)?.modelName === m.modelName);
    check(`  isKlingModel("${m.display}")`, isKlingModel(m.display));
  }
  check('isKlingModel("Nano Banana Pro") is false', !isKlingModel("Nano Banana Pro"));

  // ── 3. payload gating (pure, no network) ──────────────────────────────────
  console.log("\n── payload gating ────────────────────────────────────────────");
  const base = { model: "Kling Image 3.0", prompt: "a red bicycle" };

  const t2i = buildKlingPayload({ ...base, aspectRatio: "16:9", resolution: "2K" });
  check("text-to-image body", t2i.model_name === "kling-v3" && t2i.resolution === "2k" && t2i.n === 1,
    JSON.stringify(t2i));
  check("no `image` key when there is no reference", !("image" in t2i));
  check("negative_prompt is never sent", !("negative_prompt" in t2i));

  const i2i = buildKlingPayload({
    ...base,
    references: [{ mimeType: "image/png", data: "AAAA" }],
  });
  check("image-to-image sets a bare base64 `image`", i2i.image === "AAAA");

  const rejects = [
    ["4K is rejected (Omni-only)", () => buildKlingPayload({ ...base, resolution: "4K" })],
    [
      "two references are rejected, not trimmed",
      () =>
        buildKlingPayload({
          ...base,
          references: [
            { mimeType: "image/png", data: "A" },
            { mimeType: "image/png", data: "B" },
          ],
        }),
    ],
    [
      `a prompt over ${KLING_PROMPT_MAX} chars is rejected`,
      () => buildKlingPayload({ ...base, prompt: "x".repeat(KLING_PROMPT_MAX + 1) }),
    ],
    ["an unsupported aspect ratio is rejected", () => buildKlingPayload({ ...base, aspectRatio: "5:1" })],
    ["an unknown model is rejected", () => buildKlingPayload({ ...base, model: "Kling Image 9.9" })],
  ];
  for (const [label, fn] of rejects) {
    let threw = false;
    let msg = "";
    try {
      fn();
    } catch (e) {
      threw = true;
      msg = e.message;
    }
    check(label, threw, threw ? `→ ${msg.slice(0, 90)}` : "DID NOT THROW");
  }

  // ── 4. server-side validation, free because nothing is created ────────────
  console.log("\n── server rejects (no task created, so no charge) ────────────");
  const badModel = await call("/v1/images/generations", {
    method: "POST",
    body: JSON.stringify({ model_name: "kling-v99", prompt: "test", n: 1 }),
  });
  check("an unknown model_name is rejected server-side", badModel.json?.code !== 0,
    `http=${badModel.status} code=${badModel.json?.code} message=${badModel.json?.message}`);

  const noPrompt = await call("/v1/images/generations", {
    method: "POST",
    body: JSON.stringify({ model_name: "kling-v2-1", n: 1 }),
  });
  check("a missing prompt is rejected server-side", noPrompt.json?.code !== 0,
    `http=${noPrompt.status} code=${noPrompt.json?.code} message=${noPrompt.json?.message}`);

  // This is the one assumption only the server can settle: that kling-v3 and
  // kling-v2-1 really are valid on THIS endpoint for THIS account. Ask with an
  // otherwise-invalid body so the model name is validated without a task being
  // created — a different error message for a bad model vs a bad prompt is the
  // signal.
  for (const m of KLING_MODELS) {
    const r = await call("/v1/images/generations", {
      method: "POST",
      body: JSON.stringify({ model_name: m.modelName, prompt: "", n: 1 }),
    });
    const msg = String(r.json?.message ?? "");
    check(
      `${m.modelName} is a recognised model on this account`,
      !/model/i.test(msg),
      `code=${r.json?.code} message=${msg.slice(0, 90)}`
    );
  }

  // ── 4b. which resolutions each model really accepts ───────────────────────
  //
  // FOUR SOURCES DISAGREE HERE, so this is settled by asking the endpoint.
  //   - the API reference for Kling Image 2.1 lists enum `1k | 2k`
  //   - the kling.ai WEB app offers "2K HD" on IMAGE 2.1
  //   - the Capability Map lists 1K/2K for both models
  //   - production returned, on kling-v2-1 only:
  //       http 400, code 1201: resolution value '2k' is not supported
  // The first three are not as strong as they look: the enum block on the API
  // page carries "Different model versions support varying ranges — refer to
  // the Capability Map", i.e. it is the UNION across versions rather than a
  // per-model guarantee; the web product is a different surface from the Open
  // Platform; and the Capability Map has now over-claimed for v2-1 twice (see
  // also image_reference/human_fidelity in providers/kling.js's header). Only
  // the endpoint's own answer decides what we are allowed to send.
  //
  // Both failing production rows carried a reference image, so this tests
  // text-to-image AND image-to-image separately — "2k is invalid for v2-1" and
  // "2k is invalid for v2-1 *with a reference*" are different bugs with
  // different fixes, and the second would mean 2K is still reachable for
  // prompt-only jobs.
  //
  // FREE: every request carries n=99 against a documented max of 9, so
  // validation always fails and no task is ever created. We only read which
  // field Kling blames. If it names the resolution, that resolution is out; if
  // it names n (as the 1k controls do), the resolution got through.
  console.log("\n── resolution enum per model × mode (free, no task created) ──");
  // A real 512×512 PNG: Kling requires references ≥300px, and a token 1×1 would
  // be blamed for its size instead of telling us anything about `resolution`.
  const refPng = (
    await sharp({
      create: { width: 512, height: 512, channels: 3, background: { r: 200, g: 40, b: 40 } },
    })
      .png()
      .toBuffer()
  ).toString("base64");

  const blames = {};
  for (const m of KLING_MODELS) {
    for (const res of ["1k", "2k"]) {
      for (const mode of ["t2i", "i2i"]) {
        const r = await call("/v1/images/generations", {
          method: "POST",
          body: JSON.stringify({
            model_name: m.modelName,
            prompt: "a red bicycle",
            aspect_ratio: "1:1",
            resolution: res,
            n: 99,
            ...(mode === "i2i" ? { image: refPng } : {}),
          }),
        });
        const msg = String(r.json?.message ?? "");
        const blamed = /resolution/i.test(msg);
        blames[`${m.modelName}:${res}:${mode}`] = blamed;
        console.log(
          `      ${m.modelName.padEnd(11)} ${res}  ${mode}  →  ` +
            `${blamed ? "RESOLUTION REJECTED" : "resolution accepted"}` +
            `   (code=${r.json?.code} ${msg.slice(0, 60)})`
        );
      }
    }
  }

  for (const mode of ["t2i", "i2i"]) {
    check(`kling-v3 accepts 1k (${mode})`, !blames[`kling-v3:1k:${mode}`]);
    check(`kling-v3 accepts 2k (${mode})`, !blames[`kling-v3:2k:${mode}`]);
    check(`kling-v2-1 accepts 1k (${mode})`, !blames[`kling-v2-1:1k:${mode}`]);
  }
  // The belief this repo encodes, and the two lines to revisit if either flips.
  // Derived from our own generation history: four 2K text-to-image rows on
  // kling-v2-1 succeeded 2026-07-30 (refs=0), and 2K WITH a reference failed
  // 2026-08-17 with code 1201.
  check(
    "kling-v2-1 accepts 2k in text-to-image",
    !blames["kling-v2-1:2k:t2i"],
    blames["kling-v2-1:2k:t2i"]
      ? "→ 2K is now refused for v2-1 outright; narrow KLING_MODELS to ['1K']"
      : ""
  );
  check(
    "kling-v2-1 rejects 2k with a reference",
    blames["kling-v2-1:2k:i2i"],
    blames["kling-v2-1:2k:i2i"]
      ? ""
      : "→ 2K+reference works now; drop twoKNeedsNoReference and isKling2KModel"
  );

  // ── 5. optional: one real, billed generation ──────────────────────────────
  if (process.argv.includes("--generate")) {
    console.log("\n── REAL GENERATION (billed) ──────────────────────────────────");
    const started = Date.now();
    const result = await generateImageKling({
      model: "Kling Image 2.1",
      prompt: "a single red bicycle leaning against a white wall, soft daylight",
      aspectRatio: "1:1",
      resolution: "1K",
    });
    console.log(`url            ${result.url.slice(0, 100)}`);
    console.log(`unitDeduction  ${result.unitDeduction ?? "(not reported)"}`);
    console.log(`elapsed        ${((Date.now() - started) / 1000).toFixed(1)}s`);
    const head = await fetch(result.url, { method: "GET", headers: { Range: "bytes=0-1023" } });
    check("the result URL is fetchable", head.ok, `http=${head.status} type=${head.headers.get("content-type")}`);
  } else {
    console.log("\n(skipping the billed generation — pass --generate to run it)");
  }

  console.log(`\n${failures === 0 ? "all checks passed" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
