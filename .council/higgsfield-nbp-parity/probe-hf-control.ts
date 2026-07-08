/**
 * Council control probe (user-approved, 2 paid generations ≈28¢):
 * run the EXACT baseline prompt + the same 3 (downscaled) refs through
 * Higgsfield NBP via our MCP provider at 21:9/2k — fresh calibrated ground
 * truth for what their platform returns at defaults, measured next to the
 * user's saved comparison image.
 * Run: npx tsx .council/higgsfield-nbp-parity/probe-hf-control.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { promises as fs } from "node:fs";
import path from "node:path";

const DIR = path.join(process.cwd(), ".council/higgsfield-nbp-parity");

const PROMPT =
  "THIS EXACT FACE and identity from @img1(image_1). She stands near a DJ booth in the corner of the nightclub from @img3(image_3), Speaker stacks behind her. She wears the exact outfit from @img2(image_2). Black onyx drop earrings and a delicate black choker. Red haze, silhouettes of dancers around her. Cinematic nightlife photography. @img1";

async function main() {
  const { mcpUploadImage, mcpGenerateImage, mcpAwaitJob } = await import(
    "../../src/lib/providers/higgsfield-mcp"
  );
  const sharp = (await import("sharp")).default;

  const mediaIds: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const buf = await fs.readFile(path.join(DIR, `ref-${i}.jpg`));
    mediaIds.push(await mcpUploadImage(buf.toString("base64"), "image/jpeg"));
    console.log(`uploaded ref-${i}`);
  }

  const jobs: string[] = [];
  for (let run = 1; run <= 2; run++) {
    jobs.push(
      await mcpGenerateImage({
        model: "Higgsfield Nano Banana Pro",
        prompt: PROMPT,
        aspectRatio: "21:9",
        resolution: "2k",
        mediaIds,
      })
    );
    console.log(`submitted control job ${run}: ${jobs[run - 1]}`);
  }

  for (const [i, jobId] of jobs.entries()) {
    const done = await mcpAwaitJob(jobId);
    if (done.status !== "succeeded" || !done.url) {
      console.error(`job ${jobId} failed:`, done.error || done.status);
      continue;
    }
    const res = await fetch(done.url);
    const buf = Buffer.from(await res.arrayBuffer());
    const f = path.join(DIR, `hf-control-${i + 1}.png`);
    await fs.writeFile(f, buf);
    const m = await sharp(buf).metadata();
    console.log(`hf-control-${i + 1}.png ${m.width}x${m.height} (${buf.length} bytes)`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
