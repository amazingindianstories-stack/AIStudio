/**
 * A/B harness: same prompt + refs through every pipeline variant, judged for
 * face identity by Gemini Flash. Run: npx tsx scripts/ab-face-eval.ts <genId>
 * (genId = an existing generation whose prompt/refs to reuse; defaults to the
 * Naisha Durga Puja shot). Outputs JPEGs + scores.json to --out dir.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { promises as fs } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import sharp from "sharp";
import { assemblePrompt } from "../src/lib/prompt-assembler";
import { prepReference, identityCrops } from "../src/lib/middleware/image-prep";
import { generateImageGemini } from "../src/lib/providers/gemini";
import {
  mcpUploadImage,
  mcpGenerateImage,
  mcpAwaitJob,
} from "../src/lib/providers/higgsfield-mcp";

const GEN_ID = process.argv[2] || "424609d7-2e23-467d-9e89-39cf6392fca3";
const OUT =
  process.env.AB_OUT ||
  path.join(process.cwd(), "public", "media", "ab", GEN_ID.slice(0, 8));
const API_ROOT = "https://generativelanguage.googleapis.com/v1beta";
const AR = "21:9";

interface Img {
  mimeType: string;
  data: string;
}

async function geminiRaw(
  model: string,
  parts: Array<Record<string, unknown>>,
  imageSize: "1K" | "2K" | "4K"
): Promise<Img> {
  const res = await fetch(
    `${API_ROOT}/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GOOGLE_API_KEY!,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: { aspectRatio: AR, imageSize },
        },
      }),
    }
  );
  if (!res.ok) throw new Error(`${model}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const part = (json?.candidates?.[0]?.content?.parts ?? []).find(
    (p: any) => p?.inlineData?.data
  );
  if (!part) throw new Error(`${model}: no image (${json?.candidates?.[0]?.finishReason})`);
  return { mimeType: part.inlineData.mimeType || "image/png", data: part.inlineData.data };
}

/** Gemini-as-judge: identity match of the main woman vs the reference face. */
async function judge(refFace: Img, candidate: Img): Promise<{ identity: number; quality: number; notes: string }> {
  const res = await fetch(
    `${API_ROOT}/models/gemini-2.5-flash:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GOOGLE_API_KEY!,
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: "IMAGE 1 — ground-truth reference face of a specific person:" },
              { inlineData: { mimeType: refFace.mimeType, data: refFace.data } },
              { text: "IMAGE 2 — a generated cinematic frame whose main female character is supposed to be that exact person:" },
              { inlineData: { mimeType: candidate.mimeType, data: candidate.data } },
              {
                text:
                  `Compare the main woman's face in IMAGE 2 to IMAGE 1 like a ` +
                  `forensic examiner: bone structure, jawline, eye shape/spacing, ` +
                  `eyebrows, nose, lips, face shape, apparent age. Answer JSON: ` +
                  `{"identity": 0-100 (100 = unmistakably the SAME person, ` +
                  `50 = related-looking, 0 = different person), "quality": 0-100 ` +
                  `(cinematic/photoreal craft of the whole frame), "notes": ` +
                  `"<one sentence on the biggest facial difference>"}`,
              },
            ],
          },
        ],
        generationConfig: { responseMimeType: "application/json", temperature: 0 },
      }),
    }
  );
  const json = await res.json();
  const text = (json?.candidates?.[0]?.content?.parts ?? []).find(
    (p: any) => typeof p?.text === "string"
  )?.text;
  try {
    const p = JSON.parse(text);
    return { identity: Number(p.identity) || 0, quality: Number(p.quality) || 0, notes: String(p.notes || "") };
  } catch {
    return { identity: -1, quality: -1, notes: "judge parse failed" };
  }
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const sql = postgres(process.env.DATABASE_URL!);
  const [row] = await sql`select prompt, reference_images from generations where id = ${GEN_ID}`;
  await sql.end();
  if (!row) throw new Error(`generation ${GEN_ID} not found`);
  const prompt: string = row.prompt;
  const refPaths: string[] = row.reference_images as string[];

  // Load refs from public/ as data URLs (what the app passes to the assembler).
  const uploads: string[] = [];
  const rawRefs: Img[] = [];
  for (const p of refPaths) {
    const buf = await fs.readFile(path.join(process.cwd(), "public", p));
    const mime = p.endsWith(".webp") ? "image/webp" : p.endsWith(".jpg") ? "image/jpeg" : "image/png";
    const prepped = await prepReference(mime, buf.toString("base64"));
    rawRefs.push(prepped);
    uploads.push(`data:${prepped.mimeType};base64,${prepped.data}`);
  }

  const assembled = await assemblePrompt(prompt, [], uploads);
  const identityGroups = assembled.groups.filter((g) => g.identity);
  const refFace = (await identityCrops(rawRefs[0].mimeType, rawRefs[0].data, 1))[0] || rawRefs[0];
  console.log(`prompt ${prompt.length} chars, refs ${uploads.length}, identity groups ${identityGroups.length}`);

  const results: Array<{ name: string; file?: string; ms?: number; error?: string; identity?: number; quality?: number; notes?: string }> = [];

  async function record(name: string, fn: () => Promise<Img>) {
    const t0 = Date.now();
    try {
      const img = await fn();
      const ms = Date.now() - t0;
      const file = path.join(OUT, `${name}.jpg`);
      await fs.writeFile(file, Buffer.from(img.data, "base64"));
      const score = await judge(refFace, img);
      results.push({ name, file, ms, ...score });
      console.log(`✓ ${name} (${Math.round(ms / 1000)}s) identity=${score.identity} quality=${score.quality} — ${score.notes}`);
    } catch (e: any) {
      results.push({ name, error: e?.message?.slice(0, 200) });
      console.log(`✗ ${name}: ${e?.message?.slice(0, 200)}`);
    }
  }

  // Clean-minimal input shape (Higgsfield-style): instruction text, then the
  // raw ref images. No contract, no headers, no tiles.
  const cleanParts = [
    { text: assembled.instruction },
    ...rawRefs.map((r) => ({ inlineData: { mimeType: r.mimeType, data: r.data } })),
  ];

  const round = Number(process.env.AB_ROUND || 1);
  if (round === 3) {
    // Bake-off: top contenders, 3 samples each (generation is stochastic —
    // single samples are noise). Judged and averaged.
    for (let i = 1; i <= 3; i++) {
      await record(`R3-clean-nb2-4k-s${i}`, () => geminiRaw("gemini-3.1-flash-image", cleanParts, "4K"));
      await record(`R3-full-nb2-4k-s${i}`, async () => {
        const r = await generateImageGemini({ assembled, aspectRatio: AR, imageSize: "4K", modelDisplay: "Nano Banana 2" });
        return { mimeType: r.mimeType, data: r.base64 };
      });
      await record(`R3-higgsfield-s${i}`, async () => {
        const mediaIds: string[] = [];
        for (const r of rawRefs) mediaIds.push(await mcpUploadImage(r.data, r.mimeType));
        const jobId = await mcpGenerateImage({
          model: "Higgsfield Nano Banana Pro",
          prompt: assembled.instruction,
          aspectRatio: AR,
          resolution: "2k",
          mediaIds,
        });
        const done = await mcpAwaitJob(jobId);
        if (done.status !== "succeeded" || !done.url) throw new Error(done.error || "failed");
        const res = await fetch(done.url);
        return { mimeType: "image/png", data: Buffer.from(await res.arrayBuffer()).toString("base64") };
      });
    }
    await finish();
    // Averages per config.
    const byCfg: Record<string, number[]> = {};
    for (const r of results) {
      if (r.identity == null || r.identity < 0) continue;
      const cfg = r.name.replace(/-s\d$/, "");
      (byCfg[cfg] ||= []).push(r.identity);
    }
    console.log("\n=== ROUND 3 AVERAGES ===");
    for (const [cfg, scores] of Object.entries(byCfg)) {
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
      console.log(`${cfg}: avg identity ${avg.toFixed(1)} (${scores.join(", ")})`);
    }
    return;
  }
  if (round === 2) {
    // G. Full pipeline (contract + refs-first + tiling) on NB2 at 4K.
    await record("G-full-nb2-4k", async () => {
      const r = await generateImageGemini({ assembled, aspectRatio: AR, imageSize: "4K", modelDisplay: "Nano Banana 2" });
      return { mimeType: r.mimeType, data: r.base64 };
    });
    // H. Full pipeline on NB Pro at 4K (raw Pro quality at max pixels).
    await record("H-full-nbp-4k", async () => {
      const r = await generateImageGemini({ assembled, aspectRatio: AR, imageSize: "4K", modelDisplay: "Nano Banana Pro" });
      return { mimeType: r.mimeType, data: r.base64 };
    });
    await finish();
    return;
  }

  // A. Higgsfield MCP baseline — exactly what the app's HF path does today.
  await record("A-higgsfield-nbp-2k", async () => {
    const mediaIds: string[] = [];
    for (const r of rawRefs) mediaIds.push(await mcpUploadImage(r.data, r.mimeType));
    const jobId = await mcpGenerateImage({
      model: "Higgsfield Nano Banana Pro",
      prompt: assembled.instruction,
      aspectRatio: AR,
      resolution: "2k",
      mediaIds,
    });
    const done = await mcpAwaitJob(jobId);
    if (done.status !== "succeeded" || !done.url) throw new Error(done.error || "failed");
    const res = await fetch(done.url);
    const buf = Buffer.from(await res.arrayBuffer());
    return { mimeType: "image/png", data: buf.toString("base64") };
  });

  // B. Clean-minimal direct on NB2 at 2K.
  await record("B-clean-nb2-2k", () => geminiRaw("gemini-3.1-flash-image", cleanParts, "2K"));

  // C. Same but 4K output (pixel-budget hypothesis: HF's 2k = 3168px wide).
  await record("C-clean-nb2-4k", () => geminiRaw("gemini-3.1-flash-image", cleanParts, "4K"));

  // D. Our full pipeline on NB2 (contract + refs-first + tiling).
  await record("D-full-nb2-2k", async () => {
    const r = await generateImageGemini({ assembled, aspectRatio: AR, imageSize: "2K", modelDisplay: "Nano Banana 2" });
    return { mimeType: r.mimeType, data: r.base64 };
  });
  // E. Our full pipeline on NB Pro.
  await record("E-full-nbp-2k", async () => {
    const r = await generateImageGemini({ assembled, aspectRatio: AR, imageSize: "2K", modelDisplay: "Nano Banana Pro" });
    return { mimeType: r.mimeType, data: r.base64 };
  });

  await finish();

  // Report + dimensions.
  async function finish() {
    for (const r of results) {
      if (r.file) {
        const meta = await sharp(r.file).metadata();
        (r as any).dims = `${meta.width}x${meta.height}`;
      }
    }
    await fs.writeFile(path.join(OUT, `scores-round${round}.json`), JSON.stringify(results, null, 2));
    console.log("\n=== RESULTS (sorted by identity) ===");
    for (const r of [...results].sort((a, b) => (b.identity ?? -2) - (a.identity ?? -2))) {
      console.log(
        r.error
          ? `${r.name}: ERROR ${r.error}`
          : `${r.name}: identity=${r.identity} quality=${r.quality} ${(r as any).dims} ${Math.round((r.ms || 0) / 1000)}s — ${r.notes}`
      );
    }
    console.log("\nImages in:", OUT);
  }
}

main().catch((e) => {
  console.error("HARNESS FAILED:", e);
  process.exit(1);
});
