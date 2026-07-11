/**
 * Pure builder: turns an AssembledPrompt (the same structure Nano Banana Pro
 * consumes — role-labeled reference groups, identity tiles, shot-spec framing/
 * negative codas) into Gemini Omni Flash's Interactions API `input` array.
 *
 * Mirrors providers/gemini.ts's buildParts (header → images → tiles-under-
 * budget → SCENE → FINAL CHECK), retargeted at Interactions content parts
 * instead of generateContent parts. Same contract: user reference images are
 * NEVER dropped to fit a budget — only identity tiles yield, and exceeding the
 * cap on user images is a loud error, not a silent truncation.
 */
import type { AssembledPrompt } from "./prompt-assembler";

/** Documented per-prompt image cap for gemini-omni-flash-preview (same model
 *  family limit as gemini-3-pro-image). */
export const OMNI_MAX_IMAGES = 14;

export type OmniContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mime_type: string; data: string };

export function buildOmniInput(assembled: AssembledPrompt): OmniContentPart[] {
  const { instruction, shotInstruction, groups } = assembled;

  const userImages = groups.reduce((n, g) => n + g.images.length, 0);
  if (userImages > OMNI_MAX_IMAGES) {
    throw new Error(
      `Too many reference images: ${userImages}. Gemini Omni Flash accepts ` +
        `at most ${OMNI_MAX_IMAGES} images per prompt — remove ${userImages - OMNI_MAX_IMAGES}.`
    );
  }

  let budget = OMNI_MAX_IMAGES - userImages; // room left for identity tiles
  const parts: OmniContentPart[] = [];
  let hasIdentity = false;

  for (const group of groups) {
    parts.push({ type: "text", text: group.header });
    for (const img of group.images) {
      parts.push({ type: "image", mime_type: img.mimeType, data: img.data });
    }
    if (group.identity) hasIdentity = true;
    for (const tile of group.tiles ?? []) {
      if (budget <= 0) break;
      parts.push({ type: "image", mime_type: tile.mimeType, data: tile.data });
      budget -= 1;
    }
  }

  // shotInstruction (PROMPT_SHOT_SPEC=1) already carries its own "SCENE:"
  // prefix — never double-prefix it (same rule as gemini.ts buildParts).
  parts.push({
    type: "text",
    text: shotInstruction ?? (groups.length ? `SCENE: ${instruction}` : instruction),
  });

  if (hasIdentity) {
    parts.push({
      type: "text",
      text:
        "FINAL CHECK: every person referenced above must be a 1:1 photographic " +
        "match to their reference images (bone structure, eyes, nose, lips, " +
        "jawline, skin tone, apparent age) in every frame of the video. If " +
        "not, correct it.",
    });
  }

  return parts;
}
