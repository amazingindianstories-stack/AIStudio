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
