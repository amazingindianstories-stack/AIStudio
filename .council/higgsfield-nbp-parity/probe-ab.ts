/**
 * Stage 2 A/B harness (design.md §Probe harness, extended per recon facts 7–8):
 * measures payload-shape variants against the baseline rows' exact refs+prompt
 * at 21:9/2K on the direct generativelanguage NBP endpoint.
 *
 * Variants (4 samples each unless noted):
 *   OLD        — today's payload shape (all flags off)
 *   NEW        — PROMPT_SHOT_SPEC=1 (role headers + legend + framing + AVOID)
 *   NEWCRISP   — the SAME 4 NEW images, crispen() applied post-hoc (deterministic,
 *                so no extra generations; deviation from design's 4 fresh samples)
 *   NEWSS      — PROMPT_SHOT_SPEC=1 rendered at 4K, lanczos3-downsampled to 2K
 *   HFMIMIC    — Higgsfield's observed minimal shape: ONE text part with inline
 *                <<<image_N>>> bindings + the 3 refs. No headers/tiles/FINAL CHECK.
 *                (Added after the 2 paid controls beat our baselines 2/2 with
 *                identical starved refs — recon fact 8.)
 * Zero-spend anchors scored with the same metrics: baseline-1/2.jpg (ours) and
 * hf-control-1/2.png (Higgsfield's output for the same inputs).
 *
 * Metrics per image: identity (judgeIdentity vs the ref-1 face crop),
 * faceBoxFraction (own flash detection call), faceLaplacianVar (variance of a
 * 3x3 laplacian over the detected face crop ONLY — recon fact 6 rules out
 * whole-frame sharpness). Writes results-ab.md + results-ab.json + ab-*.jpg.
 *
 * Optional: PROBE_HIRES_DIR with ref-hi-1..3.jpg adds OLDHI/NEWHI (lever 2).
 * Run: npx tsx .council/higgsfield-nbp-parity/probe-ab.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { promises as fs } from "node:fs";
import path from "node:path";

const DIR = path.join(process.cwd(), ".council/higgsfield-nbp-parity");
const API_ROOT = "https://generativelanguage.googleapis.com/v1beta";
const SAMPLES = 4;

const PROMPT =
  "THIS EXACT FACE and identity from @img1(image_1). She stands near a DJ booth in the corner of the nightclub from @img3(image_3), Speaker stacks behind her. She wears the exact outfit from @img2(image_2). Black onyx drop earrings and a delicate black choker. Red haze, silhouettes of dancers around her. Cinematic nightlife photography. @img1";

interface Row {
  variant: string;
  sample: string;
  identity: number | null;
  faceBoxFraction: number | null;
  faceLaplacianVar: number | null;
  width: number;
  height: number;
  ms: number;
  file: string;
}

async function dataUrl(file: string): Promise<string> {
  const buf = await fs.readFile(file);
  const mime = file.endsWith(".png") ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/** Face box (0–1000 coords) of the main woman in a frame, via flash. */
async function detectFaceBox(
  mimeType: string,
  base64: string
): Promise<{ xmin: number; ymin: number; xmax: number; ymax: number } | null> {
  const apiKey = process.env.GOOGLE_API_KEY!;
  const model = process.env.GEMINI_DETECT_MODEL || "gemini-2.5-flash";
  try {
    const res = await fetch(`${API_ROOT}/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType, data: base64 } },
              {
                text:
                  'Detect the FACE of the main (most prominent) woman in this image. Answer JSON: {"box_2d": [ymin, xmin, ymax, xmax]} with coordinates 0-1000, or {"box_2d": null} if no face.',
              },
            ],
          },
        ],
        generationConfig: { responseMimeType: "application/json", temperature: 0 },
      }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const text = (json?.candidates?.[0]?.content?.parts ?? []).find(
      (p: any) => typeof p?.text === "string"
    )?.text;
    const b = JSON.parse(text)?.box_2d;
    if (!Array.isArray(b) || b.length !== 4) return null;
    const [ymin, xmin, ymax, xmax] = b.map(Number);
    if (![ymin, xmin, ymax, xmax].every(Number.isFinite) || ymax <= ymin || xmax <= xmin) return null;
    return { xmin, ymin, xmax, ymax };
  } catch {
    return null;
  }
}

/** Variance of a 3x3 laplacian over the face crop (offset 128 to keep sign). */
async function faceLaplacianVar(
  buf: Buffer,
  box: { xmin: number; ymin: number; xmax: number; ymax: number }
): Promise<number | null> {
  const sharp = (await import("sharp")).default;
  try {
    const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.height) return null;
    const left = Math.max(0, Math.round((box.xmin / 1000) * meta.width));
    const top = Math.max(0, Math.round((box.ymin / 1000) * meta.height));
    const width = Math.min(meta.width - left, Math.round(((box.xmax - box.xmin) / 1000) * meta.width));
    const height = Math.min(meta.height - top, Math.round(((box.ymax - box.ymin) / 1000) * meta.height));
    if (width < 8 || height < 8) return null;
    const raw = await sharp(buf)
      .extract({ left, top, width, height })
      .greyscale()
      .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0], offset: 128 })
      .raw()
      .toBuffer();
    let sum = 0;
    for (const v of raw) sum += v - 128;
    const mean = sum / raw.length;
    let varSum = 0;
    for (const v of raw) varSum += (v - 128 - mean) ** 2;
    return varSum / raw.length;
  } catch {
    return null;
  }
}

async function scoreImage(
  variant: string,
  sample: string,
  buf: Buffer,
  mimeType: string,
  refFace: { mimeType: string; data: string },
  ms: number,
  file: string
): Promise<Row> {
  const sharp = (await import("sharp")).default;
  const { judgeIdentity } = await import("../../src/lib/middleware/face-judge");
  const meta = await sharp(buf).metadata();
  // Judge/detect on a downscaled copy (consistent visual budget, faster).
  const small = await sharp(buf).resize({ width: 1536 }).jpeg({ quality: 90 }).toBuffer();
  const smallB64 = small.toString("base64");
  const [identity, box] = await Promise.all([
    judgeIdentity(refFace, { mimeType: "image/jpeg", data: smallB64 }),
    detectFaceBox("image/jpeg", smallB64),
  ]);
  const frac = box ? ((box.xmax - box.xmin) / 1000) * ((box.ymax - box.ymin) / 1000) : null;
  const lap = box ? await faceLaplacianVar(buf, box) : null; // crop from the FULL-RES image
  return {
    variant,
    sample,
    identity,
    faceBoxFraction: frac,
    faceLaplacianVar: lap,
    width: meta.width || 0,
    height: meta.height || 0,
    ms,
    file,
  };
}

/** Direct REST call for HFMIMIC — the minimal payload Higgsfield sends. */
async function generateMimic(refs: { mimeType: string; data: string }[]): Promise<{ base64: string; mimeType: string }> {
  const apiKey = process.env.GOOGLE_API_KEY!;
  const prompt = PROMPT.replace(/@img(\d+)/gi, (_, n) => `<<<image_${n}>>>`);
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          ...refs.map((r) => ({ inlineData: { mimeType: r.mimeType, data: r.data } })),
        ],
      },
    ],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio: "21:9", imageSize: "2K" },
    },
  };
  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`${API_ROOT}/models/gemini-3-pro-image:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const json = await res.json();
      const part = (json?.candidates?.[0]?.content?.parts ?? []).find((p: any) => p?.inlineData?.data);
      if (part) return { base64: part.inlineData.data, mimeType: part.inlineData.mimeType || "image/png" };
      lastErr = "no image part";
    } else {
      lastErr = `${res.status} ${(await res.text()).slice(0, 200)}`;
      if (res.status < 429) break;
    }
    await new Promise((r) => setTimeout(r, 4000 * attempt));
  }
  throw new Error(`HFMIMIC generation failed: ${lastErr}`);
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      console.log(`${label} attempt ${attempt} failed: ${String((e as Error).message).slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw lastErr;
}

function mean(xs: Array<number | null>): number | null {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

async function main() {
  if (!process.env.GOOGLE_API_KEY) {
    console.log("GOOGLE_API_KEY is empty in .env.local — not spending; exiting (decisions.md #7).");
    process.exit(0);
  }
  const sharp = (await import("sharp")).default;
  const { assemblePrompt } = await import("../../src/lib/prompt-assembler");
  const { generateImageGemini } = await import("../../src/lib/providers/gemini");
  const { identityCrops, crispen } = await import("../../src/lib/middleware/image-prep");

  const refFiles = [1, 2, 3].map((i) => path.join(DIR, `ref-${i}.jpg`));
  const uploads = await Promise.all(refFiles.map(dataUrl));
  const refBufs = await Promise.all(refFiles.map((f) => fs.readFile(f)));
  const refsInline = refBufs.map((b) => ({ mimeType: "image/jpeg", data: b.toString("base64") }));

  // Ground-truth face for the identity metric: face crop from the @img1 sheet.
  const crops = await identityCrops("image/jpeg", refsInline[0].data, 1);
  if (!crops.length) throw new Error("no face crop from ref-1 — cannot score identity");
  const refFace = { mimeType: crops[0].mimeType, data: crops[0].data };
  console.log("ref face crop ready");

  const rows: Row[] = [];
  const t0 = Date.now();
  let spendCents = 0;

  // --- zero-spend anchors ---
  for (const [variant, file] of [
    ["BASELINE", "baseline-1.jpg"],
    ["BASELINE", "baseline-2.jpg"],
    ["HFCONTROL", "hf-control-1.png"],
    ["HFCONTROL", "hf-control-2.png"],
  ] as const) {
    const buf = await fs.readFile(path.join(DIR, file));
    rows.push(await scoreImage(variant, file, buf, file.endsWith(".png") ? "image/png" : "image/jpeg", refFace, 0, file));
    console.log(`scored anchor ${file}`);
  }

  // --- generated variants ---
  type GenVariant = {
    name: string;
    flags: Record<string, string>;
    imageSize: "2K" | "4K";
    downsampleTo?: number; // target width after generation
    count: number;
    costCents: number;
  };
  const variants: GenVariant[] = [
    { name: "OLD", flags: {}, imageSize: "2K", count: SAMPLES, costCents: 21 },
    { name: "NEW", flags: { PROMPT_SHOT_SPEC: "1" }, imageSize: "2K", count: SAMPLES, costCents: 21 },
    { name: "NEWSS", flags: { PROMPT_SHOT_SPEC: "1" }, imageSize: "4K", downsampleTo: 3168, count: SAMPLES, costCents: 28 },
  ];

  const hires = process.env.PROBE_HIRES_DIR;
  let hiresUploads: string[] | null = null;
  if (hires) {
    try {
      hiresUploads = await Promise.all([1, 2, 3].map((i) => dataUrl(path.join(hires, `ref-hi-${i}.jpg`))));
      variants.push(
        { name: "OLDHI", flags: {}, imageSize: "2K", count: SAMPLES, costCents: 21 },
        { name: "NEWHI", flags: { PROMPT_SHOT_SPEC: "1" }, imageSize: "2K", count: SAMPLES, costCents: 21 }
      );
    } catch {
      console.log("PROBE_HIRES_DIR set but ref-hi-*.jpg unreadable — skipping HI variants");
    }
  }

  const newImages: { buf: Buffer; sample: string }[] = [];

  for (const v of variants) {
    const ups = v.name.endsWith("HI") && hiresUploads ? hiresUploads : uploads;
    for (const k of Object.keys(v.flags)) process.env[k] = v.flags[k];
    try {
      const assembled = await assemblePrompt(PROMPT, [], ups, { aspectRatio: "21:9" });
      const gens = await Promise.allSettled(
        Array.from({ length: v.count }, (_, i) =>
          withRetry(async () => {
            const t = Date.now();
            const out = await generateImageGemini({ assembled, aspectRatio: "21:9", imageSize: v.imageSize });
            return { out, ms: Date.now() - t, i };
          }, `${v.name}#${i + 1}`)
        )
      );
      for (const g of gens) {
        if (g.status === "rejected") {
          console.log(`${v.name} sample failed: ${String(g.reason?.message).slice(0, 150)}`);
          continue;
        }
        spendCents += v.costCents;
        let buf = Buffer.from(g.value.out.base64, "base64");
        if (v.downsampleTo) {
          buf = await sharp(buf).resize({ width: v.downsampleTo, kernel: "lanczos3" }).png().toBuffer();
        }
        const sample = `${v.name.toLowerCase()}-${g.value.i + 1}`;
        const file = `ab-${sample}.jpg`;
        await fs.writeFile(path.join(DIR, file), await sharp(buf).jpeg({ quality: 95 }).toBuffer());
        rows.push(await scoreImage(v.name, sample, buf, "image/png", refFace, g.value.ms, file));
        if (v.name === "NEW") newImages.push({ buf, sample });
        console.log(`scored ${v.name} ${sample}`);
      }
    } finally {
      for (const k of Object.keys(v.flags)) delete process.env[k];
    }
  }

  // --- NEWCRISP: crispen() over the NEW images, no new generations ---
  for (const { buf, sample } of newImages) {
    const b64 = buf.toString("base64");
    const t = Date.now();
    const crisped = await crispen("image/png", b64);
    const cbuf = Buffer.from(crisped.data, "base64");
    const file = `ab-crisp-${sample}.jpg`;
    await fs.writeFile(path.join(DIR, file), await sharp(cbuf).jpeg({ quality: 95 }).toBuffer());
    rows.push(await scoreImage("NEWCRISP", `crisp-${sample}`, cbuf, crisped.mimeType, refFace, Date.now() - t, file));
    console.log(`scored NEWCRISP crisp-${sample}`);
  }

  // --- HFMIMIC: minimal Higgsfield-shape payload, direct REST ---
  const mimics = await Promise.allSettled(
    Array.from({ length: SAMPLES }, (_, i) =>
      withRetry(async () => {
        const t = Date.now();
        const out = await generateMimic(refsInline);
        return { out, ms: Date.now() - t, i };
      }, `HFMIMIC#${i + 1}`)
    )
  );
  for (const g of mimics) {
    if (g.status === "rejected") {
      console.log(`HFMIMIC sample failed: ${String(g.reason?.message).slice(0, 150)}`);
      continue;
    }
    spendCents += 21;
    const buf = Buffer.from(g.value.out.base64, "base64");
    const sample = `hfmimic-${g.value.i + 1}`;
    const file = `ab-${sample}.jpg`;
    await fs.writeFile(path.join(DIR, file), await sharp(buf).jpeg({ quality: 95 }).toBuffer());
    rows.push(await scoreImage("HFMIMIC", sample, buf, g.value.out.mimeType, refFace, g.value.ms, file));
    console.log(`scored HFMIMIC ${sample}`);
  }

  // --- report ---
  await fs.writeFile(path.join(DIR, "results-ab.json"), JSON.stringify(rows, null, 2));
  const fmt = (x: number | null, d = 1) => (x === null ? "—" : x.toFixed(d));
  const lines = [
    "# A/B results — higgsfield-nbp-parity",
    "",
    `Run: ${new Date().toISOString()} · total wall ${(Date.now() - t0) / 1000 | 0}s · new-generation spend ≈ ${spendCents}¢`,
    "",
    "faceBoxFraction = detected face area / frame area (subject prominence).",
    "faceLaplacianVar = laplacian variance on the FACE crop of the full-res frame (sharpness).",
    "identity = judgeIdentity vs the @img1 face crop (0–100).",
    "",
    "| variant | sample | identity | faceBoxFrac | faceLapVar | dims | ms |",
    "|---|---|---|---|---|---|---|",
    ...rows.map(
      (r) =>
        `| ${r.variant} | ${r.sample} | ${fmt(r.identity, 0)} | ${fmt(
          r.faceBoxFraction === null ? null : r.faceBoxFraction * 100,
          2
        )}% | ${fmt(r.faceLaplacianVar)} | ${r.width}×${r.height} | ${r.ms} |`
    ),
    "",
    "## Per-variant means",
    "",
    "| variant | n | identity | faceBoxFrac | faceLapVar |",
    "|---|---|---|---|---|",
  ];
  const byVariant = new Map<string, Row[]>();
  for (const r of rows) byVariant.set(r.variant, [...(byVariant.get(r.variant) || []), r]);
  for (const [name, rs] of byVariant) {
    lines.push(
      `| ${name} | ${rs.length} | ${fmt(mean(rs.map((r) => r.identity)), 1)} | ${fmt(
        (mean(rs.map((r) => r.faceBoxFraction)) ?? NaN) * 100,
        2
      )}% | ${fmt(mean(rs.map((r) => r.faceLaplacianVar)), 1)} |`
    );
  }
  lines.push(
    "",
    "Limitation: refs are the client-starved 1024px stored copies — lever 2 (ref fidelity)",
    "is not A/B-testable from these artifacts (design.md §Probe harness)." +
      (hiresUploads ? " HI variants used PROBE_HIRES_DIR originals." : "")
  );
  await fs.writeFile(path.join(DIR, "results-ab.md"), lines.join("\n"));
  console.log(`\ndone — ${rows.length} rows, spend ≈ ${spendCents}¢, see results-ab.md`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
