/**
 * Nano Banana Pro (gemini-3-pro-image) — the app's image engine.
 *
 * Endpoint choice is measured, not assumed (2026-07-03 probes, judged on the
 * Naisha benchmark):
 * - Vertex AI serves this exact model but currently returns 1K no matter what
 *   (`imageConfig.imageSize` is validated — garbage values 400 — yet 2K/4K are
 *   preview-gated and silently ignored). The generativelanguage endpoint
 *   honors 2K/4K for real (6336×2688 measured at 21:9/4K).
 * - Reference ingestion is a flat ~258 tokens per image on BOTH endpoints
 *   (countTokens; mediaResolution HIGH == default, ULTRA_HIGH invalid), so
 *   identity tiling — face/sheet-panel crops sent as separate images — is what
 *   carries facial detail. Grouped+tiled parts scored 41.7 avg / 65 best
 *   identity vs 15–20 for an untiled prompt+images shape.
 * - Face-fix second passes are disproven: NBP self-refine changed nothing
 *   (65→65, 25→25) and Imagen-capability face inpaint degraded identity
 *   (65→35, 65→15). The lever that works is best-of-N (see the route).
 *
 * Hard model limit: 14 images per prompt (Vertex model card). User reference
 * images are never dropped to fit — we error loudly; only tiles yield.
 */
import type { AssembledPrompt } from "../prompt-assembler";

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta";
const MODEL = "gemini-3-pro-image";
/** Documented per-prompt image cap for gemini-3-pro-image. */
const MAX_IMAGES = 14;

export interface GeminiImageInput {
  assembled: AssembledPrompt;
  aspectRatio?: string; // "1:1" | "3:4" | "4:3" | "9:16" | "16:9" | "21:9"
  imageSize?: "1K" | "2K" | "4K";
  modelDisplay?: string; // kept for the route's logging; engine is always NBP
}

export interface GeminiImageResult {
  base64: string;
  mimeType: string;
}

interface Part {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

/**
 * Build the multimodal parts in the probe-winning shape: each reference group
 * as [header text, images…, identity tiles…], then the literal SCENE, then a
 * short identity FINAL CHECK (recency slot) when any identity ref exists.
 */
function buildParts(assembled: AssembledPrompt): Part[] {
  const { instruction, groups } = assembled;

  const userImages = groups.reduce((n, g) => n + g.images.length, 0);
  if (userImages > MAX_IMAGES) {
    throw new Error(
      `Too many reference images: ${userImages}. Nano Banana Pro accepts at ` +
        `most ${MAX_IMAGES} images per prompt — remove ${userImages - MAX_IMAGES}.`
    );
  }

  let budget = MAX_IMAGES - userImages; // room left for identity tiles
  const parts: Part[] = [];
  let hasIdentity = false;

  for (const group of groups) {
    parts.push({ text: group.header });
    for (const img of group.images) {
      parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
    }
    if (group.identity) hasIdentity = true;
    for (const tile of group.tiles ?? []) {
      if (budget <= 0) break;
      parts.push({ inlineData: { mimeType: tile.mimeType, data: tile.data } });
      budget -= 1;
    }
  }

  parts.push({ text: groups.length ? `SCENE: ${instruction}` : instruction });
  if (hasIdentity) {
    parts.push({
      text:
        "FINAL CHECK: every person referenced above must be a 1:1 photographic " +
        "match to their reference images (bone structure, eyes, nose, lips, " +
        "jawline, skin tone, apparent age). If not, correct it.",
    });
  }
  return parts;
}

export async function generateImageGemini(
  input: GeminiImageInput
): Promise<GeminiImageResult> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_API_KEY is not set.");

  const body = {
    contents: [{ role: "user", parts: buildParts(input.assembled) }],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: {
        aspectRatio: input.aspectRatio || "1:1",
        imageSize: input.imageSize || "1K",
      },
    },
  };

  // One retry on transient failures (429/5xx) — NBP 503s under load.
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch(
      `${API_ROOT}/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) {
      const errText = await res.text();
      lastError = `Gemini image error (${res.status}): ${errText.slice(0, 400)}`;
      if ((res.status === 429 || res.status >= 500) && attempt === 1) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      throw new Error(lastError);
    }
    const json = await res.json();
    const part = (json?.candidates?.[0]?.content?.parts ?? []).find(
      (p: any) => p?.inlineData?.data
    );
    if (!part) {
      const reason = json?.candidates?.[0]?.finishReason || "no candidates";
      lastError = `Gemini returned no image (${reason}).`;
      if (attempt === 1) continue; // empty response — worth one retry
      throw new Error(lastError);
    }
    return {
      base64: part.inlineData.data,
      mimeType: part.inlineData.mimeType || "image/png",
    };
  }
  throw new Error(lastError || "Gemini image generation failed.");
}
