/**
 * Reference-image middleware (server-only).
 *
 * R&D result of probing Higgsfield's stored generation params via their MCP:
 * they do NO prompt rewriting (prompts pass through verbatim), and they DO
 * preprocess reference images (`…_resize.jpg` inputs). The real input-quality
 * gap is reference fidelity (their uploads were 2–4× larger originals; ours
 * were client-starved to ~1KP). Research A3.2 (2026-07-10) measured the render
 * pixel budget: 21:9@2k = 3168×1344 on both Higgsfield and our generativelanguage
 * endpoint — no hidden advantage there. This module replicates their ref
 * preprocessing for our own calls and adds one thing they don't visibly do — an
 * automatic close-up face crop of each identity reference, so the model gets
 * dense facial detail even when the subject is small/mid-distance in the
 * composed shot (the exact situation where face lock fails).
 *
 * Everything here is fail-open: any error returns the original image.
 */

import sharp from "sharp";
import type { RefRole } from "../shot-spec";

export interface PreppedImage {
  mimeType: string;
  data: string; // base64, no data: prefix
}

/** Cap the longest side of a reference image (Higgsfield-style `_resize`).
 *  Oversized refs waste Gemini input tokens and get downscaled server-side
 *  anyway — better to control the resize ourselves. */
const MAX_REF_DIM = 2048;

export async function prepReference(
  mimeType: string,
  base64: string
): Promise<PreppedImage> {
  try {
    const buf = Buffer.from(base64, "base64");
    const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.height) return { mimeType, data: base64 };
    if (Math.max(meta.width, meta.height) <= MAX_REF_DIM) {
      return { mimeType, data: base64 };
    }
    const out = await sharp(buf)
      .resize({ width: MAX_REF_DIM, height: MAX_REF_DIM, fit: "inside" })
      .jpeg({ quality: 92 })
      .toBuffer();
    return { mimeType: "image/jpeg", data: out.toString("base64") };
  } catch {
    return { mimeType, data: base64 };
  }
}

/**
 * Classical same-size "crisping" pass approximating the observed Topaz recipe
 * (sharpen ~0.3–0.5, no face_enhancement, NO repaint) — gated behind
 * POST_CRISPEN=1 and applied only to the winning best-of-N candidate before
 * save. Sharpen-only: this exact pass was A/B-validated artifact-free on
 * matched face crops (a median(1) "denoise" here is an identity op, and
 * median(3) would change the validated behavior — don't add a denoise step
 * without re-probing). Never resizes. Fail-open: any error returns the input
 * unchanged.
 */
export async function crispen(mimeType: string, base64: string): Promise<PreppedImage> {
  try {
    const buf = Buffer.from(base64, "base64");
    const out = await sharp(buf)
      .sharpen({ sigma: 1, m1: 0.5, m2: 0.3 })
      .toBuffer();
    return { mimeType, data: out.toString("base64") };
  } catch {
    return { mimeType, data: base64 };
  }
}

// ── face-crop enrichment ─────────────────────────────────────────────────────

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta";

/** Gemini is trained for object detection: it returns `box_2d` as
 *  [ymin, xmin, ymax, xmax] normalized to 0–1000. */
interface Box2d {
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
}

function parseBox(b: unknown): Box2d | null {
  if (!Array.isArray(b) || b.length !== 4) return null;
  const [ymin, xmin, ymax, xmax] = (b as unknown[]).map(Number);
  if ([ymin, xmin, ymax, xmax].some((v) => !Number.isFinite(v))) return null;
  if (ymax <= ymin || xmax <= xmin) return null;
  return { ymin, xmin, ymax, xmax };
}

interface IdentityBoxes {
  face: Box2d | null;
  panels: Box2d[];
}

/** Classify + locate in ONE call. The gate matters: users upload location/set/
 *  style references too, and cropping a random bystander's face out of those
 *  would inject a WRONG identity into the generation. Verified against real
 *  refs: a character sheet → true + face panel box; a studio set with
 *  anonymized faces → false. Also returns per-panel boxes for character
 *  sheets, so each panel can become its own image (its own 258-token tile). */
async function detectIdentityBoxes(
  mimeType: string,
  base64: string
): Promise<IdentityBoxes | null> {
  // Transient failures (429/5xx) must not silently strip identity tiling from
  // a generation — retry once, and log loudly when detection is lost.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const out = await detectIdentityBoxesOnce(mimeType, base64);
    if (out !== "retryable") return out;
    if (attempt === 1) await new Promise((r) => setTimeout(r, 1500));
  }
  console.log("[image-prep] WARN: face detection failed twice — no identity tiles this run");
  return null;
}

async function detectIdentityBoxesOnce(
  mimeType: string,
  base64: string
): Promise<IdentityBoxes | null | "retryable"> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return null;
  const model = process.env.GEMINI_DETECT_MODEL || "gemini-2.5-flash";
  const res = await fetch(
    `${API_ROOT}/models/${encodeURIComponent(model)}:generateContent`,
    {
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
                  `You are helping build a face-identity pipeline. Look at this image and answer as JSON: ` +
                  `{"person_reference": <bool>, "face_box_2d": [ymin, xmin, ymax, xmax] | null, "panel_boxes": [[ymin, xmin, ymax, xmax], ...] | null}. ` +
                  `"person_reference" is true if the image is primarily a reference of ONE specific person — a portrait, headshot, character sheet, or a photo whose clear main subject is a single person. ` +
                  `IMPORTANT: Even if the image is a character sheet where some panels have faces blanked out, hidden, or anonymized (e.g. with white boxes), if there is AT LEAST ONE clear, visible face of the subject in any panel, "person_reference" MUST be true. ` +
                  `It is false ONLY for locations, sets, crowds, objects, style frames, or images where ALL faces are hidden/anonymized. ` +
                  `When true, "face_box_2d" is the tight bounding box of that person's CLEAR face (largest/clearest instance if shown multiple times; ignore blanked out faces). ` +
                  `"panel_boxes" applies ONLY when the image is a character sheet / collage of several distinct panels showing the same person (e.g. front view, profile, full body): give one box per panel (even if the face is blanked out in that panel), up to 4, most identity-relevant first; otherwise null. ` +
                  `All coordinates normalized to 0-1000.`
              },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0,
          // No thinking needed for detection — cuts latency ~10s → ~3s.
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    }
  );
  if (!res.ok) {
    console.log(`[image-prep] detection HTTP ${res.status}${res.status === 429 || res.status >= 500 ? " (will retry)" : ""}`);
    return res.status === 429 || res.status >= 500 ? "retryable" : null;
  }
  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.find(
    (p: any) => typeof p?.text === "string"
  )?.text;
  if (!text) return "retryable"; // empty/blocked response — worth one retry
  try {
    const parsed = JSON.parse(text);
    const face = parseBox(parsed?.face_box_2d);
    const panels = Array.isArray(parsed?.panel_boxes)
      ? (parsed.panel_boxes.map(parseBox).filter(Boolean) as Box2d[])
      : [];
      
    // Resiliency: if Gemini conservatively flagged false, but successfully found a face
    // or distinct panels, assume it IS an identity reference.
    const isPerson = parsed?.person_reference === true || !!face || panels.length > 0;
    
    if (!isPerson) return null;
    if (!face && !panels.length) return null;
    
    return { face, panels };
  } catch {
    return "retryable"; // malformed JSON — model hiccup, retry once
  }
}

interface PixelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function toPixels(
  box: Box2d,
  imgW: number,
  imgH: number,
  pad: number
): PixelRect | null {
  const w = ((box.xmax - box.xmin) / 1000) * imgW;
  const h = ((box.ymax - box.ymin) / 1000) * imgH;
  const left = Math.max(0, Math.round(((box.xmin / 1000) * imgW) - w * pad));
  const top = Math.max(0, Math.round(((box.ymin / 1000) * imgH) - h * pad));
  const right = Math.min(imgW, Math.round((box.xmin / 1000) * imgW + w * (1 + pad)));
  const bottom = Math.min(imgH, Math.round((box.ymin / 1000) * imgH + h * (1 + pad)));
  const cw = right - left;
  const ch = bottom - top;
  if (cw < 64 || ch < 64) return null; // too small to carry useful detail
  return { left, top, width: cw, height: ch };
}

/** How much of rect `a` is covered by rect `b` (0–1). */
function coveredBy(a: PixelRect, b: PixelRect): number {
  const ix =
    Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const iy =
    Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  if (ix <= 0 || iy <= 0) return 0;
  return (ix * iy) / (a.width * a.height);
}

async function renderCrop(
  buf: Buffer,
  rect: PixelRect
): Promise<PreppedImage> {
  let img = sharp(buf).extract(rect);
  // Never upscale — invented pixels soften the face. Only cap oversized crops;
  // past ~1536px there's no gain (flat token budget per image).
  if (Math.max(rect.width, rect.height) > 1536) {
    img = img.resize({ width: 1536, height: 1536, fit: "inside" });
  }
  const out = await img.jpeg({ quality: 95 }).toBuffer();
  return { mimeType: "image/jpeg", data: out.toString("base64") };
}

/**
 * Identity tiling: Gemini ingests EVERY image as one flat ~258-token tile
 * (measured via countTokens — a 3168px character sheet gets the same visual
 * budget as a thumbnail). The fix is to multiply tiles: face close-up + each
 * sheet panel as SEPARATE images, so one identity ref becomes 3–4× the visual
 * bandwidth. Returns [] when the ref isn't a person / detection unavailable.
 * Disable via FACE_CROP_MIDDLEWARE=0.
 */
export async function identityCrops(
  mimeType: string,
  base64: string,
  maxCrops = 3
): Promise<PreppedImage[]> {
  if (process.env.FACE_CROP_MIDDLEWARE === "0") return [];
  const debug = (...a: unknown[]) =>
    process.env.MIDDLEWARE_DEBUG && console.log("[image-prep]", ...a);
  try {
    const boxes = await detectIdentityBoxes(mimeType, base64);
    debug("boxes:", JSON.stringify(boxes));
    if (!boxes) return [];
    const buf = Buffer.from(base64, "base64");
    const meta = await sharp(buf).metadata();
    if (!meta.width || !meta.height) return [];
    const area = meta.width * meta.height;

    const rects: PixelRect[] = [];
    // Face first — ~45% padding keeps hair, ears and jaw context. Skip when
    // the raw face box already fills half the frame (the ref IS a close-up;
    // check the unpadded box, not the padded crop).
    if (boxes.face) {
      const rawArea =
        ((boxes.face.xmax - boxes.face.xmin) / 1000) *
        meta.width *
        (((boxes.face.ymax - boxes.face.ymin) / 1000) * meta.height);
      const r = toPixels(boxes.face, meta.width, meta.height, 0.45);
      debug("face rect:", JSON.stringify(r), "rawArea%", Math.round((rawArea / area) * 100));
      if (r && rawArea <= area * 0.5) rects.push(r);
    }
    // Then sheet panels — light padding; skip near-duplicates of crops we
    // already have and panels that are basically the whole image.
    for (const p of boxes.panels) {
      if (rects.length >= maxCrops) break;
      const r = toPixels(p, meta.width, meta.height, 0.04);
      if (!r) continue;
      if (r.width * r.height > area * 0.85) {
        debug("panel skipped (≈whole image):", JSON.stringify(r));
        continue;
      }
      if (rects.some((prev) => coveredBy(r, prev) > 0.6 || coveredBy(prev, r) > 0.6)) {
        debug("panel skipped (overlap):", JSON.stringify(r));
        continue;
      }
      rects.push(r);
    }

    const out: PreppedImage[] = [];
    for (const rect of rects.slice(0, maxCrops)) {
      out.push(await renderCrop(buf, rect));
    }
    return out;
  } catch (e) {
    debug("error:", (e as Error)?.message);
    return [];
  }
}

// ── role classification (PROMPT_ROLE_DETECT fallback) ──────────────────────

const ROLE_DETECT_PROMPT =
  `Classify the PRIMARY subject of this reference image for a photo ` +
  `generation pipeline. Answer JSON: {"role": "person"|"outfit"|"location"|"style"|"prop"|"object"}. ` +
  `"person" = the main subject is a specific individual's face/identity ` +
  `(portrait, headshot, character sheet). "outfit" = the main subject is ` +
  `clothing/garments/jewelry meant to be worn, not a specific person's ` +
  `identity. "location" = a place, set, room, venue or backdrop. "style" = a ` +
  `mood board / color palette / lighting or rendering reference, not a ` +
  `concrete scene or object. "prop" = a specific physical object meant to be ` +
  `reproduced (e.g. a car, a phone, a piece of furniture). "object" = none of ` +
  `the above fit clearly.`;

const VALID_ROLES: RefRole[] = ["person", "outfit", "location", "style", "prop", "object"];

/** Extended-schema role classifier for an upload (person/outfit/location/style/
 *  prop/object). Used ONLY as the PROMPT_ROLE_DETECT fallback/cross-check —
 *  its own single call, additive to identityCrops/detectIdentityBoxes. Fail-
 *  open: returns null when unavailable (no key / HTTP error / parse fail),
 *  letting the caller fall back to today's identity signal. */
export async function detectReferenceRole(
  mimeType: string,
  base64: string
): Promise<RefRole | null> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return null;
  const model = process.env.GEMINI_DETECT_MODEL || "gemini-2.5-flash";
  try {
    const res = await fetch(
      `${API_ROOT}/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { inlineData: { mimeType, data: base64 } },
                { text: ROLE_DETECT_PROMPT },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0,
            // No thinking needed for classification — cuts latency ~10s → ~3s.
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      }
    );
    if (!res.ok) return null;
    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.find(
      (p: any) => typeof p?.text === "string"
    )?.text;
    if (!text) return null;
    const role = JSON.parse(text)?.role;
    return VALID_ROLES.includes(role) ? (role as RefRole) : null;
  } catch {
    return null;
  }
}
