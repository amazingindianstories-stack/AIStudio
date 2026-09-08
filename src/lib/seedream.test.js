import { test } from "vitest";
import assert from "node:assert/strict";
import sharp from "sharp";
import { seedreamSize, SEEDREAM_SIZES, resolveSeedreamReferences } from "./seedream";
import { seedreamPayload, generateImageSeedream } from "./providers/seedream";
import { normalizeSeedreamReference } from "./seedream-reference";
import { computeSeedreamCostCents, SEEDREAM_PRICING } from "./pricing";

test("Pro uses documented dimensions, rejects 4K and unknown aspects", () => {
  assert.equal(seedreamSize(), "2048x2048");
  assert.equal(seedreamSize("2K", "16:9"), "2816x1584");
  for (const sizes of Object.values(SEEDREAM_SIZES)) assert.equal(Object.keys(sizes).length, 6);
  assert.throws(() => seedreamSize("4K"));
  assert.throws(() => seedreamSize("2K", "7:5"));
});
test("payload omits unsupported generation controls and supports override", () => {
  assert.deepEqual(seedreamPayload({ prompt: "hello", seed: 3, references: ["a"] }, { SEEDREAM_MODEL: "override" }), { model: "override", prompt: "hello", size: "2048x2048", response_format: "url", output_format: "png", watermark: false, optimize_prompt_options: { mode: "standard" }, image: ["a"] });
});
test("named assets expand in order with roles and edits retained", () => {
  const result = resolveSeedreamReferences("Use @hero with @img2; change coat to red", [{ slug: "hero", kind: "character", name: "Hero", description: "blue coat", images: ["a", "b"] }], ["c", "d"]);
  assert.deepEqual(result.references, ["a", "b", "d"]);
  assert.match(result.prompt, /image 1, image 2/);
  assert.match(result.prompt, /character: Hero — blue coat/);
  assert.match(result.prompt, /image 3; change coat to red/);
  assert.match(resolveSeedreamReferences("@img1-inspired coat", [], ["a"]).prompt, /image 1-inspired coat/);
});
test("ten resolved references accepted, eleven and missing tags rejected", () => {
  assert.equal(resolveSeedreamReferences("compose", [], Array(10).fill("a")).references.length, 10);
  assert.throws(() => resolveSeedreamReferences("compose", [], Array(11).fill("a")), /at most 10/);
  assert.throws(() => resolveSeedreamReferences("@img2", [], ["a"]), /missing/);
  assert.throws(() => resolveSeedreamReferences("@missing"), /Missing reference/);
});
test("fractional cents accumulate before rounding, actual dimension threshold and custom rates", () => {
  const cost = (pixels, count = 0, rows = SEEDREAM_PRICING) => computeSeedreamCostCents({ width: pixels, height: 1, referenceCount: count }, rows);
  assert.equal(cost(2_610_000), 5);
  assert.equal(cost(2_610_001), 9);
  assert.equal(cost(2_610_000, 10), 7);
  assert.equal(cost(2_610_001, 10), 12);
  assert.equal(cost(1, 2, SEEDREAM_PRICING.map(p => ({ ...p, unitCostCents: 1000 }))), 2);
});
test("compliant original bytes are unchanged; corrupt and invalid dimensions reject", async () => {
  const bytes = await sharp({ create: { width: 2500, height: 100, channels: 3, background: "red" } }).png().toBuffer();
  await assert.rejects(normalizeSeedreamReference(bytes), /aspect ratio/);
  const original = await sharp({ create: { width: 2500, height: 2000, channels: 3, background: "red" } }).png().toBuffer();
  const result = await normalizeSeedreamReference(original);
  assert.equal(result.bytes, original);
  assert.equal(result.changed, false);
  await assert.rejects(normalizeSeedreamReference(Buffer.from("corrupt")), /corrupt/);
});
test("oversized opaque and transparent references shrink without crop or upscale", async () => {
  for (const channels of [3, 4]) {
    const input = await sharp({ create: { width: 7200, height: 6000, channels, background: { r: 5, g: 10, b: 15, alpha: 0.5 } } }).png().toBuffer();
    const result = await normalizeSeedreamReference(input);
    const meta = await sharp(result.bytes).metadata();
    assert.ok(meta.width * meta.height <= 36_000_000);
    assert.ok(Math.abs(meta.width / meta.height - 1.2) < 0.001);
    assert.equal(result.ext, channels === 4 ? "png" : "jpg");
  }
});
test("provider failures, malformed results, and download failures never resubmit", async () => {
  for (const status of [401, 403, 400, 429, 500]) {
    let calls = 0;
    await assert.rejects(generateImageSeedream({ prompt: "test" }, { env: { ARK_API_KEY: "test" }, fetchImpl: async () => { calls++; return { ok: false, status, json: async () => ({ error: { code: "Rejected", message: "secret signed URL" } }) }; } }), e => !e.message.includes("secret"));
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(generateImageSeedream({ prompt: "test" }, { env: { ARK_API_KEY: "test" }, fetchImpl: async () => { calls++; throw new Error("timeout"); } }), /not resubmitted/);
  assert.equal(calls, 1);
  await assert.rejects(generateImageSeedream({ prompt: "test" }, { env: { ARK_API_KEY: "test" }, fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }) }), /no valid/);
  calls = 0;
  await assert.rejects(generateImageSeedream({ prompt: "test" }, { env: { ARK_API_KEY: "test" }, fetchImpl: async () => ++calls === 1 ? { ok: true, json: async () => ({ data: [{ url: "https://provider/image" }] }) } : { ok: false, status: 503 } }), /download failed/);
  assert.equal(calls, 2);
});

test("reference preparation preserves originals, signs only for provider, reads sequentially and rejects missing uploads", async () => {
  const { prepareSeedreamReferences } = await import("./seedream-reference");
  const bytes = await sharp({ create: { width: 100, height: 100, channels: 3, background: "red" } }).png().toBuffer();
  let active = 0, maxActive = 0, uploads = 0;
  const refs = Array.from({ length: 10 }, (_, i) => `/api/media/references/${i}.png`);
  const result = await prepareSeedreamReferences(refs, "job", {
    read: async () => { active++; maxActive = Math.max(maxActive, active); await new Promise(r => setTimeout(r, 1)); active--; return { data: bytes.toString("base64") }; },
    upload: async () => { uploads++; }, signRef: async () => "https://storage/image?expires=600",
  });
  assert.deepEqual(result.stable, refs);
  assert.equal(result.urls.length, 10);
  assert.equal(maxActive, 1);
  assert.equal(uploads, 0);
  await assert.rejects(prepareSeedreamReferences(["/api/media/references/missing.png"], "job", { read: async () => { throw new Error("expired URL secret"); } }), e => /Upload it again/.test(e.message) && !e.message.includes("secret"));
  await assert.rejects(prepareSeedreamReferences(["/api/media/uploads/image-reference/other-uuid"], "job", { userId: "me" }), /another user/);
  await assert.rejects(prepareSeedreamReferences(["https://external/image?token=secret"], "job"), /stored original/);
});

test("provider abort propagates the same signal and does not submit again", async () => {
  const controller = new AbortController();
  let calls = 0;
  const running = generateImageSeedream({ prompt: "test" }, { env: { ARK_API_KEY: "test" }, signal: controller.signal, fetchImpl: async (_url, options) => {
    calls++;
    assert.equal(options.signal, controller.signal);
    return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  } });
  controller.abort();
  await assert.rejects(running, /not resubmitted/);
  assert.equal(calls, 1);
});
