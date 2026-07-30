import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PRICING,
  VIDEO_RESOLUTION_FACTOR,
  KLING_UNIT_CENTS,
  audioRowModel,
  computeCostCents,
  imageToImageRowModel,
  klingUnitsToCents,
  type PricingRow,
} from "./pricing";

const rows: PricingRow[] = [
  { model: "Seedance 2.0", unitCostCents: 8, unit: "per_second" },
  { model: "Seedance 2.0 · audio", unitCostCents: 2, unit: "per_second" },
  { model: "Nano Banana Pro", unitCostCents: 14, unit: "per_image" },
];

const video = (patch: Partial<Parameters<typeof computeCostCents>[0]> = {}) =>
  computeCostCents(
    { kind: "video", model: "Seedance 2.0", duration: 10, resolution: "720p", ...patch },
    rows
  );

test("video cost scales with duration", () => {
  assert.equal(video({ duration: 5 }), 40);
  assert.equal(video({ duration: 10 }), 80);
});

test("video cost scales with resolution", () => {
  // The flat model charged these identically, so per-user attribution was wrong
  // by several times for anyone working at 480p or 1080p.
  assert.equal(video({ resolution: "480p" }), Math.round(8 * 10 * 0.44));
  assert.equal(video({ resolution: "720p" }), 80);
  assert.equal(video({ resolution: "1080p" }), Math.round(8 * 10 * 2.46));
});

test("720p is the base rate, i.e. factor exactly 1", () => {
  // The admin UI tells the operator the number they type is the 720p rate.
  assert.equal(VIDEO_RESOLUTION_FACTOR["720p"], 1);
});

test("an unknown resolution falls back to the base rate, not to zero", () => {
  assert.equal(video({ resolution: "4K" }), 80);
  assert.equal(video({ resolution: undefined }), 80);
});

test("audio is added on top, at the same duration", () => {
  assert.equal(video({ generateAudio: true }), 8 * 10 + 2 * 10);
});

test("audio and resolution compound correctly", () => {
  // Resolution scales the video only — audio is a flat per-second surcharge, so
  // folding it into the base rate would have overcharged it at 1080p.
  assert.equal(
    video({ generateAudio: true, resolution: "1080p" }),
    Math.round(8 * 10 * 2.46 + 2 * 10)
  );
});

test("silent generations are never charged the audio surcharge", () => {
  assert.equal(video({ generateAudio: false }), 80);
  assert.equal(video({}), 80);
});

test("audio is free when the surcharge row is missing or zero", () => {
  const noAudioRow: PricingRow[] = [rows[0]];
  assert.equal(
    computeCostCents(
      { kind: "video", model: "Seedance 2.0", duration: 10, resolution: "720p", generateAudio: true },
      noAudioRow
    ),
    80
  );
  const zeroed: PricingRow[] = [rows[0], { ...rows[1], unitCostCents: 0 }];
  assert.equal(
    computeCostCents(
      { kind: "video", model: "Seedance 2.0", duration: 10, resolution: "720p", generateAudio: true },
      zeroed
    ),
    80,
    "setting the surcharge to 0 must switch audio billing off"
  );
});

test("image pricing is unaffected by the video changes", () => {
  assert.equal(
    computeCostCents({ kind: "image", model: "Nano Banana Pro", resolution: "1K" }, rows),
    14
  );
  assert.equal(
    computeCostCents({ kind: "image", model: "Nano Banana Pro", resolution: "4K" }, rows),
    42
  );
});

test("an unpriced model costs zero rather than throwing", () => {
  assert.equal(computeCostCents({ kind: "video", model: "Nope", duration: 10 }, rows), 0);
});

test("every audio seed row names a base model that also exists", () => {
  // A surcharge row whose base model is missing or misspelled would silently
  // never apply.
  const names = new Set(DEFAULT_PRICING.map((p) => p.model));
  const audioRows = DEFAULT_PRICING.filter((p) => p.model.includes("· audio"));
  assert.ok(audioRows.length > 0, "expected at least one audio surcharge row");
  for (const a of audioRows) {
    const base = a.model.replace(" · audio", "");
    assert.ok(names.has(base), `audio row "${a.model}" has no base model "${base}"`);
    assert.equal(audioRowModel(base), a.model);
    assert.equal(a.unit, "per_second");
  }
});

test("audio surcharge rows exist only for audio-capable models", () => {
  // Higgsfield and Omni have no audio parameter, so a surcharge row for them
  // would bill for something that cannot be requested.
  for (const p of DEFAULT_PRICING) {
    if (!p.model.includes("· audio")) continue;
    assert.ok(
      !/higgsfield|omni/i.test(p.model),
      `${p.model} cannot generate audio and must not have a surcharge row`
    );
  }
});

// ── Kling: flat-by-resolution, and a distinct image-to-image rate ───────────

const klingRows: PricingRow[] = [
  { model: "Kling Image 3.0", unitCostCents: 3, unit: "per_image" },
  { model: "Kling Image 2.1", unitCostCents: 1, unit: "per_image" },
  { model: "Kling Image 2.1 · image-to-image", unitCostCents: 3, unit: "per_image" },
  { model: "Nano Banana Pro", unitCostCents: 14, unit: "per_image" },
];

test("Kling costs the same at 1K and 2K", () => {
  // Kling publishes ONE price covering both, so applying the generic 1.5×
  // resolution factor would invent a premium it never charges.
  const at1k = computeCostCents(
    { kind: "image", model: "Kling Image 3.0", resolution: "1K" },
    klingRows
  );
  const at2k = computeCostCents(
    { kind: "image", model: "Kling Image 3.0", resolution: "2K" },
    klingRows
  );
  assert.equal(at1k, 3);
  assert.equal(at2k, 3);
});

test("non-Kling image models still scale with resolution", () => {
  // The flat rule must be scoped to Kling and not leak into everything else.
  assert.equal(
    computeCostCents({ kind: "image", model: "Nano Banana Pro", resolution: "1K" }, klingRows),
    14
  );
  assert.equal(
    computeCostCents({ kind: "image", model: "Nano Banana Pro", resolution: "2K" }, klingRows),
    21
  );
});

test("Kling Image 2.1 bills image-to-image at the higher rate", () => {
  const t2i = computeCostCents(
    { kind: "image", model: "Kling Image 2.1", resolution: "1K" },
    klingRows
  );
  const i2i = computeCostCents(
    { kind: "image", model: "Kling Image 2.1", resolution: "1K", hasReferenceImage: true },
    klingRows
  );
  assert.equal(t2i, 1);
  assert.equal(i2i, 3, "a reference image should switch to the · image-to-image row");
});

test("the image-to-image row REPLACES the base rate rather than adding to it", () => {
  // Unlike the audio rows, which are surcharges. 3, not 1 + 3.
  assert.equal(
    computeCostCents(
      { kind: "image", model: "Kling Image 2.1", hasReferenceImage: true },
      klingRows
    ),
    3
  );
});

test("a model with no image-to-image row falls back to its base rate", () => {
  // Kling Image 3.0 charges one price for both modes, so it has no companion
  // row — and must not silently become free when a reference is supplied.
  assert.equal(
    computeCostCents(
      { kind: "image", model: "Kling Image 3.0", hasReferenceImage: true },
      klingRows
    ),
    3
  );
});

test("imageToImageRowModel matches the seeded row name exactly", () => {
  const name = imageToImageRowModel("Kling Image 2.1");
  assert.equal(name, "Kling Image 2.1 · image-to-image");
  assert.ok(
    DEFAULT_PRICING.some((r) => r.model === name),
    "the seeded row name must match what computeCostCents looks up"
  );
});

test("the seeded Kling rows exist", () => {
  for (const m of ["Kling Image 3.0", "Kling Image 2.1"]) {
    assert.ok(DEFAULT_PRICING.some((r) => r.model === m), m);
  }
});

// ── reconciliation from Kling's reported units ──────────────────────────────

test("Kling units convert to cents at the published rate", () => {
  // 8 units = $0.028 and 4 units = $0.014 → $0.0035/unit = 0.35¢.
  assert.equal(KLING_UNIT_CENTS, 0.35);
  // 4 units is what a real 2.1 text-to-image job reported (2026-07-30).
  assert.equal(klingUnitsToCents(4), 1);
  assert.equal(klingUnitsToCents(8), 3);
  assert.equal(klingUnitsToCents(16), 6);
  assert.equal(klingUnitsToCents("8"), 3);
});

test("unparseable unit counts keep the estimate rather than billing zero", () => {
  assert.equal(klingUnitsToCents(undefined), undefined);
  assert.equal(klingUnitsToCents(""), undefined);
  assert.equal(klingUnitsToCents("n/a"), undefined);
  assert.equal(klingUnitsToCents(-1), undefined);
  // Zero is a legitimate report (a free/retried job), so it must NOT be
  // conflated with "unknown".
  assert.equal(klingUnitsToCents(0), 0);
});
