/** Reproduce the queue/execute direct-Gemini path with the user's flags
 *  (PROMPT_SHOT_SPEC=1, JUDGE_COMPOSITE=1) outside HTTP, to find what kills
 *  the dev process. Stage 1: assemblePrompt only (no image spend). */
import { config } from "dotenv";
config({ path: ".env.local" });
import { promises as fs } from "node:fs";

process.on("uncaughtException", (e) => {
  console.error("UNCAUGHT EXCEPTION:", e);
  process.exit(2);
});
process.on("unhandledRejection", (e) => {
  console.error("UNHANDLED REJECTION:", e);
  process.exit(3);
});

async function main() {
  console.log("flags:", {
    PROMPT_SHOT_SPEC: process.env.PROMPT_SHOT_SPEC,
    JUDGE_COMPOSITE: process.env.JUDGE_COMPOSITE,
    key: (process.env.GOOGLE_API_KEY || "").length > 0,
  });
  const { assemblePrompt } = await import(
    "/Users/ais4/Desktop/Rohit Chavda/Dev/image-video-project/src/lib/prompt-assembler"
  );
  const buf = await fs.readFile(
    "/Users/ais4/Desktop/Rohit Chavda/Dev/image-video-project/.council/higgsfield-nbp-parity/ref-1.jpg"
  );
  const upload = `data:image/jpeg;base64,${buf.toString("base64")}`;
  const prompt =
    "THIS EXACT FACE and identity from the reference image: @img1 Cinematic portrait of this woman seated in a director's chair backstage at a late-night talk show.";
  const assembled = await assemblePrompt(prompt, [], [upload], { aspectRatio: "21:9" });
  console.log("assemblePrompt OK:", {
    groups: assembled.groups.map((g) => ({ tag: g.tag, header: g.header.slice(0, 80), images: g.images.length, tiles: g.tiles?.length ?? 0 })),
    judgeFace: !!assembled.judgeFace,
    shotInstruction: assembled.shotInstruction,
  });
  // linger so a delayed unhandled rejection (fire-and-forget paths) surfaces
  await new Promise((r) => setTimeout(r, 8000));
  console.log("no delayed rejection — stage 1 clean");
  process.exit(0);
}

main().catch((e) => {
  console.error("MAIN THREW:", e);
  process.exit(1);
});
