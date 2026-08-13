

/** Documented per-prompt image cap for gemini-omni-flash-preview (same model
 *  family limit as gemini-3-pro-image). */
export const OMNI_MAX_IMAGES = 14;

 

export function buildOmniInput(assembled) {
  const { instruction, shotInstruction, groups } = assembled;

  const userImages = groups.reduce((n, g) => n + g.images.length, 0);
  if (userImages > OMNI_MAX_IMAGES) {
    throw new Error(
      `Too many reference images: ${userImages}. Gemini Omni Flash accepts ` +
        `at most ${OMNI_MAX_IMAGES} images per prompt — remove ${userImages - OMNI_MAX_IMAGES}.`
    );
  }

  let budget = OMNI_MAX_IMAGES - userImages; // room left for identity tiles
  const parts = [];
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
