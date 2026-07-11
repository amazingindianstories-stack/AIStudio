/** Stage 2 repro: full direct-Gemini best-of-2 + JUDGE_COMPOSITE path exactly
 *  as queue/execute runs it, outside HTTP, to catch whatever kills next dev. */
import { config } from "dotenv";
config({ path: ".env.local" });
import { promises as fs } from "node:fs";

process.on("uncaughtException", (e) => { console.error("UNCAUGHT:", e); process.exit(2); });
process.on("unhandledRejection", (e) => { console.error("UNHANDLED REJECTION:", e); process.exit(3); });

async function main() {
  const { assemblePrompt } = await import("../../src/lib/prompt-assembler");
  const { generateImageGemini } = await import("../../src/lib/providers/gemini");
  const { judgeCandidate, selectBestCandidate } = await import("../../src/lib/middleware/face-judge");

  const buf = await fs.readFile(".council/higgsfield-nbp-parity/ref-1.jpg");
  const upload = `data:image/jpeg;base64,${buf.toString("base64")}`;
  const prompt =
    "THIS EXACT FACE and identity from the reference image: @img1 Cinematic portrait of this woman seated in a director's chair backstage at a late-night talk show.";
  const assembled = await assemblePrompt(prompt, [], [upload], { aspectRatio: "21:9" });
  console.log("assembled, judgeFace:", !!assembled.judgeFace);

  const input = { assembled, aspectRatio: "21:9", imageSize: "2K" as const, modelDisplay: "Nano Banana Pro" };
  const settled = await Promise.allSettled([generateImageGemini(input), generateImageGemini(input)]);
  const candidates = settled.filter(
    (s): s is PromiseFulfilledResult<{ base64: string; mimeType: string }> => s.status === "fulfilled"
  );
  console.log("candidates:", candidates.length, settled.map((s) => s.status).join(","));
  if (!candidates.length) throw (settled[0] as PromiseRejectedResult).reason;

  const scores = await Promise.all(
    candidates.map((c) => judgeCandidate(assembled.judgeFace!, { mimeType: c.value.mimeType, data: c.value.base64 }))
  );
  const best = selectBestCandidate(scores, 8);
  console.log("scores:", JSON.stringify(scores), "→ picked", best);
  await new Promise((r) => setTimeout(r, 8000));
  console.log("stage 2 clean — no crash in the flag-on path");
  process.exit(0);
}
main().catch((e) => { console.error("MAIN THREW:", e); process.exit(1); });
