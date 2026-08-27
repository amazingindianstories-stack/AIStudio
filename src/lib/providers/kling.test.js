import test from "node:test";
import assert from "node:assert/strict";
import {
  KLING_MODELS,
  KLING_PROMPT_MAX,
  buildKlingPayload,
  createKlingImageTask,
  isKlingModel,
  klingSpec,
  nearestKlingAspectRatio,

} from "./kling";
import { resolutionsForModel } from "../config";

/**
 * These pin the parameter gating that came out of Kling's docs, so a future
 * edit can't quietly start sending a field a model rejects — or, worse, quietly
 * start dropping user input to make a request fit.
 *
 * Everything here is pure: no network, no spend. The live contract is verified
 * separately by scripts/probe-kling-image.ts.
 */

const base = { model: "Kling Image 3.0", prompt: "a red bicycle" };
const ref = { mimeType: "image/png", data: "AAAA" };

function expectThrow(fn, match) {
  assert.throws(fn, match);
}

test("model display names map to Kling's wire ids", () => {
  assert.equal(klingSpec("Kling Image 3.0")?.modelName, "kling-v3");
  assert.equal(klingSpec("Kling Image 2.1")?.modelName, "kling-v2-1");
});

test("model lookup is case- and whitespace-insensitive", () => {
  assert.equal(klingSpec("  kling image 3.0  ")?.modelName, "kling-v3");
});

test("isKlingModel matches only Kling", () => {
  assert.ok(isKlingModel("Kling Image 3.0"));
  assert.ok(isKlingModel("kling image 2.1"));
  assert.equal(isKlingModel("Nano Banana Pro"), false);
  assert.equal(isKlingModel("Seedance 2.0"), false);
  // Guard against a substring accident the way config.ts does for "seedance".
  assert.equal(isKlingModel("Sparkling Image"), false);
});

test("createKlingImageTask forwards the queue abort signal to fetch", async () => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.KLING_API;
  const controller = new AbortController();
  let capturedSignal;
  process.env.KLING_API = "test-key";
  globalThis.fetch = async (_url, init) => {
    capturedSignal = init.signal;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 0, data: { task_id: "task-signal" } }),
    };
  };
  try {
    assert.equal(
      await createKlingImageTask(base, { signal: controller.signal }),
      "task-signal"
    );
    assert.equal(capturedSignal, controller.signal);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.KLING_API;
    else process.env.KLING_API = originalKey;
  }
});

test("text-to-image body carries exactly the documented fields", () => {
  const p = buildKlingPayload({ ...base, aspectRatio: "16:9", resolution: "2K" });
  assert.deepEqual(p, {
    model_name: "kling-v3",
    prompt: "a red bicycle",
    n: 1,
    aspect_ratio: "16:9",
    resolution: "2k",
  });
});

test("resolution is lowercased for the wire", () => {
  assert.equal(buildKlingPayload({ ...base, resolution: "1K" }).resolution, "1k");
  assert.equal(buildKlingPayload({ ...base, resolution: "2K" }).resolution, "2k");
});

test("defaults are 1K and 1:1 when unspecified", () => {
  const p = buildKlingPayload(base);
  assert.equal(p.resolution, "1k");
  assert.equal(p.aspect_ratio, "1:1");
});

test("negative_prompt is never sent", () => {
  // Kling documents it as unsupported whenever `image` is set, so rather than
  // send it in one mode only, we never send it — the shot-spec system puts its
  // NEGATIVE block in the prompt text.
  assert.equal("negative_prompt" in buildKlingPayload(base), false);
  assert.equal("negative_prompt" in buildKlingPayload({ ...base, references: [ref] }), false);
});

test("v1-only fidelity knobs are never sent", () => {
  // image_reference / image_fidelity / human_fidelity are scoped to
  // kling-v1/v1-5 by the endpoint doc. Sending them to v3/v2-1 risks a 400.
  const p = buildKlingPayload({ ...base, references: [ref] }) 

;
  for (const k of ["image_reference", "image_fidelity", "human_fidelity", "element_list"]) {
    assert.equal(k in p, false, `${k} should not be sent`);
  }
});

test("a reference sets a bare base64 `image` with no data: prefix", () => {
  const p = buildKlingPayload({ ...base, references: [ref] });
  assert.equal(p.image, "AAAA");
  assert.ok(!String(p.image).startsWith("data:"), "Kling rejects the data: prefix");
});

test("`image` is absent, not empty, for text-to-image", () => {
  // An empty string would read as image-to-image mode to Kling.
  assert.equal("image" in buildKlingPayload(base), false);
});

test("n is always 1 — one row, one image, one charge", () => {
  assert.equal(buildKlingPayload(base).n, 1);
});

test("a second reference is rejected rather than dropped", () => {
  // The whole point: Kling's `image` is scalar, and quietly discarding the
  // user's other @tags would make the result inexplicable.
  expectThrow(
    () => buildKlingPayload({ ...base, references: [ref, ref] }),
    /accepts one reference image; 2 were provided/
  );
});

test("the multi-reference error names a way forward", () => {
  assert.throws(
    () => buildKlingPayload({ ...base, references: [ref, ref] }),
    /Nano Banana Pro/
  );
});

test("4K is rejected for both models, and points at Omni", () => {
  for (const m of KLING_MODELS) {
    expectThrow(
      () => buildKlingPayload({ ...base, model: m.display, resolution: "4K" }),
      /4K is Kling Image 3\.0 Omni only/
    );
  }
});

test("2.1 does 2K in text-to-image but not from a reference", () => {
  // Measured from our own history, not read from a doc: four 2K text-to-image
  // rows on Kling Image 2.1 succeeded on 2026-07-30 with refs=0, while 2K WITH
  // a reference returned `400 code 1201: resolution value '2k' is not
  // supported` on 2026-08-17. Every success had no reference; both failures
  // had one. So the restriction is reference-conditional, NOT model-wide —
  // making it model-wide would break a configuration that provably worked.
  assert.equal(
    buildKlingPayload({ ...base, model: "Kling Image 2.1", resolution: "2K" }).resolution,
    "2k"
  );
  expectThrow(
    () =>
      buildKlingPayload({
        ...base,
        model: "Kling Image 2.1",
        resolution: "2K",
        references: [ref],
      }),
    /cannot render 2K from a reference image/
  );
});

test("3.0 does 2K with a reference, which is what makes it the way forward", () => {
  const p = buildKlingPayload({
    ...base,
    model: "Kling Image 3.0",
    resolution: "2K",
    references: [ref],
  });
  assert.equal(p.resolution, "2k");
  assert.equal(p.image, "AAAA");
});

test("the composer never offers a Kling resolution the provider will reject", () => {
  // resolutionsForModel (the picker) and KLING_MODELS (the provider's gate) are
  // two separate lists, and the 2K-on-2.1 failure was exactly this drift: the
  // UI offered a value the endpoint 400s on. Pin them together in BOTH
  // reference states, since that is now part of the answer.
  for (const m of KLING_MODELS) {
    assert.deepEqual(resolutionsForModel(m.display, "image", false), m.resolutions, m.display);
    const withRef = resolutionsForModel(m.display, "image", true);
    for (const r of withRef) {
      assert.doesNotThrow(
        () => buildKlingPayload({ ...base, model: m.display, resolution: r, references: [ref] }),
        `${m.display} @ ${r} with a reference`
      );
    }
  }
});

test("an over-length prompt is rejected with both numbers", () => {
  assert.throws(
    () => buildKlingPayload({ ...base, prompt: "x".repeat(KLING_PROMPT_MAX + 1) }),
    /up to 2500 characters; this one is 2501/
  );
});

test("a prompt exactly at the cap is accepted", () => {
  const p = buildKlingPayload({ ...base, prompt: "x".repeat(KLING_PROMPT_MAX) });
  assert.equal(p.prompt.length, KLING_PROMPT_MAX);
});

test("an empty or whitespace prompt is rejected", () => {
  expectThrow(() => buildKlingPayload({ ...base, prompt: "" }), /Prompt is required/);
  expectThrow(() => buildKlingPayload({ ...base, prompt: "   " }), /Prompt is required/);
});

test("the prompt is trimmed", () => {
  assert.equal(buildKlingPayload({ ...base, prompt: "  hi  " }).prompt, "hi");
});

test("an unsupported aspect ratio is rejected and the message lists the valid set", () => {
  assert.throws(() => buildKlingPayload({ ...base, aspectRatio: "5:1" }), /3:2, 2:3, 21:9/);
});

test("every aspect ratio in the spec is actually accepted", () => {
  for (const m of KLING_MODELS) {
    for (const ar of m.aspectRatios) {
      const p = buildKlingPayload({ ...base, model: m.display, aspectRatio: ar });
      assert.equal(p.aspect_ratio, ar, `${m.display} ${ar}`);
    }
  }
});

test("an unknown model is rejected and the message lists the known ones", () => {
  assert.throws(() => buildKlingPayload({ ...base, model: "Kling Image 9.9" }), /Kling Image 3.0/);
});

// ── measured aspect ratio ───────────────────────────────────────────────────
// Kling ignores aspect_ratio in image-to-image and rounds text-to-image output
// to convenient pixel multiples, so the ratio has to be measured from the
// returned image rather than taken from the request.

test("exact ratios map to themselves", () => {
  assert.equal(nearestKlingAspectRatio(1024, 1024), "1:1");
  assert.equal(nearestKlingAspectRatio(1920, 1080), "16:9");
  assert.equal(nearestKlingAspectRatio(1080, 1920), "9:16");
  assert.equal(nearestKlingAspectRatio(1200, 900), "4:3");
  assert.equal(nearestKlingAspectRatio(900, 1200), "3:4");
  assert.equal(nearestKlingAspectRatio(1500, 1000), "3:2");
  assert.equal(nearestKlingAspectRatio(1000, 1500), "2:3");
  assert.equal(nearestKlingAspectRatio(2100, 900), "21:9");
});

test("the real measured outputs map to the right labels", () => {
  // Both observed 2026-07-30. 16:9 came back as 1.771, not 1.778 — an exact
  // string match would have found nothing.
  assert.equal(nearestKlingAspectRatio(2720, 1536), "16:9");
  // Requested 1:1 and 21:9 both returned this, following the 4:3 reference.
  assert.equal(nearestKlingAspectRatio(1168, 864), "4:3");
});

test("distance is multiplicative, so portrait and landscape behave alike", () => {
  // 4:3 vs 3:2 should be exactly as far apart as 3:4 vs 2:3. A linear
  // difference would bias every decision toward the landscape ratios.
  assert.equal(nearestKlingAspectRatio(1000, 750), "4:3");
  assert.equal(nearestKlingAspectRatio(750, 1000), "3:4");
  assert.equal(nearestKlingAspectRatio(1000, 667), "3:2");
  assert.equal(nearestKlingAspectRatio(667, 1000), "2:3");
});

test("degenerate dimensions return undefined so the request value is kept", () => {
  assert.equal(nearestKlingAspectRatio(0, 100), undefined);
  assert.equal(nearestKlingAspectRatio(100, 0), undefined);
});
