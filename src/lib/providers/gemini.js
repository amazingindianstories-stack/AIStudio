

import { buildCastPolicy } from "../shot-spec";

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta";
const MODEL = "gemini-3-pro-image";
/** Documented per-prompt image cap for gemini-3-pro-image. */
const MAX_IMAGES = 14;

/**
 * Build the multimodal parts in the probe-winning shape: each reference group
 * as [header text, images…, identity tiles…], then the literal SCENE, then a
 * short identity FINAL CHECK (recency slot) when any identity ref exists.
 */
export function buildParts(assembled) {
  const { instruction, shotInstruction, groups } = assembled;

  const userImages = groups.reduce((n, g) => n + g.images.length, 0);
  if (userImages > MAX_IMAGES) {
    throw new Error(
      `Too many reference images: ${userImages}. Nano Banana Pro accepts at ` +
        `most ${MAX_IMAGES} images per prompt — remove ${userImages - MAX_IMAGES}.`
    );
  }

  let budget = MAX_IMAGES - userImages; // room left for identity tiles
  const parts = [];
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

  // shotInstruction (PROMPT_SHOT_SPEC=1) already carries its own "SCENE:"
  // prefix — never double-prefix it.
  parts.push({
    text: shotInstruction ?? (groups.length ? `SCENE: ${instruction}` : instruction),
  });
  // Empty/location-only scenes need an explicit zero-cast contract even when
  // PROMPT_SHOT_SPEC is disabled. Person/reference scenes return null here,
  // so their proven reference → tiles → scene → FINAL CHECK shape stays
  // byte-for-byte unchanged. Camera-direction clarification is included only
  // for zero-cast prompts where phrases such as "looking down" are ambiguous.
  const castPolicy = buildCastPolicy(instruction, hasIdentity);
  if (castPolicy) parts.push({ text: castPolicy });
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

/**
 * Pull Google's own "wait this long" hint out of an error body.
 *
 * A google.rpc.Status carries structured `details`, and for RESOURCE_EXHAUSTED
 * it usually includes a RetryInfo entry whose `retryDelay` is a protobuf
 * Duration string ("31s", "1.5s"). That hint beats any backoff curve we invent,
 * because only the server knows when the spend-rate window actually reopens.
 *
 * Returns null when the body is unparseable or carries no RetryInfo — every
 * caller must have its own fallback.
 */
export function retryDelayMs(errText) {
  try {
    const details = JSON.parse(errText)?.error?.details;
    if (!Array.isArray(details)) return null;
    for (const d of details) {
      if (typeof d?.["@type"] === "string" && d["@type"].endsWith("RetryInfo")) {
        const m = /^([\d.]+)s$/.exec(String(d.retryDelay ?? ""));
        // Clamp: a hint of "0s" would busy-loop, and an absurdly long one
        // would strand the invocation. Callers still cap against their budget.
        if (m) return Math.min(Math.max(Number(m[1]) * 1000, 1000), 60_000);
      }
    }
  } catch {
    /* not JSON, or a shape we don't recognise — fall back to backoff */
  }
  return null;
}

export async function generateImageGemini(
  input
) {
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

  // Retry transient failures (429/5xx) — NBP 503s under load, and best-of-N
  // makes us our own worst offender: N renders fan out in parallel per job and
  // MAX_CONCURRENT lets several jobs run at once, so a burst of high-res work
  // trips Gemini's SPEND-based rate limit (429 RESOURCE_EXHAUSTED, measured
  // 2026-07-28 on a run of 21:9/2K jobs).
  //
  // A flat 2s single retry — what this used to do — is useless against that
  // class of 429: a spend-rate window does not reopen in 2s, so the retry
  // burned another request and rethrew. Back off exponentially instead, and
  // prefer the server's own RetryInfo hint when it sends one. The invocation
  // budget (maxDuration=300 on /api/queue/execute) is what makes waiting this
  // long viable at all; RETRY_BUDGET_MS keeps the total sleep well inside it so
  // a retry can never be the thing that gets the invocation killed.
  const RETRY_BUDGET_MS = 90_000;
  let lastError = "";
  let sleptMs = 0;
  for (let attempt = 1; attempt <= 4; attempt++) {
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
      if (res.status === 429 || res.status >= 500) {
        // Exponential backoff (4s, 8s, 16s) with jitter to de-synchronise the
        // sibling best-of-N renders, which all started together and would
        // otherwise all retry together and re-trip the same limit.
        const backoff = 4000 * 2 ** (attempt - 1);
        const wait = Math.min(
          retryDelayMs(errText) ?? backoff * (0.75 + Math.random() * 0.5),
          RETRY_BUDGET_MS - sleptMs
        );
        if (wait > 0) {
          sleptMs += wait;
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
      }
      throw new Error(lastError);
    }
    const json = await res.json();
    const part = (json?.candidates?.[0]?.content?.parts ?? []).find(
      (p) => p?.inlineData?.data
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
