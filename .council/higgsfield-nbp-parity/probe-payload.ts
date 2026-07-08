/**
 * Council recon probe: dump the exact assembled payload our pipeline builds
 * for the baseline club generation (row 31d0523e). No image-model API calls.
 * Also saves the baseline reference images + outputs locally for measurement.
 * Media is fetched via the production app (public proxy) since local AWS
 * creds are Vercel-sensitive (not pullable).
 * Run: npx tsx .council/higgsfield-nbp-parity/probe-payload.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { promises as fs } from "node:fs";
import path from "node:path";

const DIR = path.join(process.cwd(), ".council/higgsfield-nbp-parity");
const PROD = "https://aistudio-v1.vercel.app";

const PROMPT =
  "THIS EXACT FACE and identity from @img1(image_1). She stands near a DJ booth in the corner of the nightclub from @img3(image_3), Speaker stacks behind her. She wears the exact outfit from @img2(image_2). Black onyx drop earrings and a delicate black choker. Red haze, silhouettes of dancers around her. Cinematic nightlife photography. @img1";

const REFS = [
  "/api/media/references/31d0523e-a795-42f4-b25d-fa04cdb531f5-0.jpg",
  "/api/media/references/31d0523e-a795-42f4-b25d-fa04cdb531f5-1.jpg",
  "/api/media/references/31d0523e-a795-42f4-b25d-fa04cdb531f5-2.jpg",
];

const BASELINE_OUTPUTS = [
  "/api/media/generations/31d0523e-a795-42f4-b25d-fa04cdb531f5.jpg",
  "/api/media/generations/3afb7c4a-c210-4b48-b57f-a3d3c3084d27.jpg",
];

async function fetchBuf(urlPath: string): Promise<Buffer> {
  const res = await fetch(PROD + urlPath);
  if (!res.ok) throw new Error(`${res.status} for ${urlPath}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const { assemblePrompt } = await import("../../src/lib/prompt-assembler");
  const { readAssets } = await import("../../src/lib/assets-db");

  const refDataUrls: string[] = [];
  for (const [i, ref] of REFS.entries()) {
    const buf = await fetchBuf(ref);
    await fs.writeFile(path.join(DIR, `ref-${i + 1}.jpg`), buf);
    refDataUrls.push(`data:image/jpeg;base64,${buf.toString("base64")}`);
  }
  for (const [i, out] of BASELINE_OUTPUTS.entries()) {
    await fs.writeFile(path.join(DIR, `baseline-${i + 1}.jpg`), await fetchBuf(out));
  }
  console.log("saved refs + baselines to", DIR);

  const assembled = await assemblePrompt(PROMPT, await readAssets(), refDataUrls);
  let report = "=== INSTRUCTION (text part sent first) ===\n" + assembled.instruction + "\n\n";
  for (const g of assembled.groups) {
    report += `=== GROUP ${g.tag} identity=${!!g.identity} images=${g.images.length} tiles=${g.tiles?.length ?? 0} ===\nHEADER: ${g.header}\n\n`;
  }
  report += `judgeFace present: ${!!assembled.judgeFace}\n`;
  console.log(report);
  await fs.writeFile(path.join(DIR, "assembled-payload.txt"), report);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
