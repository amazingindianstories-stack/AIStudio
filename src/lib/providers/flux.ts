/**
 * FLUX.1 Kontext [dev]  ▸  fal.ai  (open-source image editing / consistency)
 *
 * Kontext does in-context editing: it pulls identity, face, and scene structure
 * from the input image and preserves them while applying the prompt's changes —
 * which is what fixes the "lost face / lost location" problem that a closed
 * text-conditioned model (Nano Banana Pro) can't guarantee.
 *
 * Synchronous call: POST https://fal.run/{model}  → images[0].url
 * Auth: Authorization: Key {FAL_KEY}  (server-only)
 * Docs: https://fal.ai/models/fal-ai/flux-kontext/dev/api
 */

import type { LabeledRef } from "../mentions";

const FAL_ROOT = "https://fal.run";

const ALLOWED_ASPECT = new Set([
  "1:1",
  "16:9",
  "9:16",
  "21:9",
  "9:21",
  "3:2",
  "2:3",
  "4:3",
  "3:4",
  "4:5",
  "5:4",
]);

export interface FluxImageInput {
  prompt: string;
  aspectRatio?: string;
  references?: LabeledRef[];
}

/** Kontext edits a single input image, so @imgN tags are meaningless to it —
 *  turn them into plain words that still read as an instruction. */
function stripTags(prompt: string): string {
  return prompt.replace(/@img(\d+)/gi, "the reference image");
}

export async function generateImageFlux(
  input: FluxImageInput
): Promise<{ url: string }> {
  const key = process.env.FAL_KEY;
  if (!key) {
    throw new Error(
      "FAL_KEY is not set. Add it to .env.local to use FLUX Kontext (get one at fal.ai/dashboard/keys)."
    );
  }
  const model = process.env.FLUX_MODEL || "fal-ai/flux-kontext/dev";

  const ref = input.references?.[0];
  if (!ref) {
    throw new Error(
      "FLUX Kontext needs at least one reference image to keep consistent. Upload an image (and tag it @img1), or switch to Nano Banana Pro for text-only generation."
    );
  }

  const resolutionMode =
    input.aspectRatio && ALLOWED_ASPECT.has(input.aspectRatio)
      ? input.aspectRatio
      : "match_input";

  const body = {
    prompt: stripTags(input.prompt.trim()),
    image_url: ref.dataUrl, // fal accepts data: URIs and auto-hosts them
    num_inference_steps: 30,
    guidance_scale: 2.5,
    num_images: 1,
    output_format: "png",
    resolution_mode: resolutionMode,
  };

  const res = await fetch(`${FAL_ROOT}/${model}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Key ${key}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`FLUX Kontext error ${res.status}: ${text.slice(0, 400)}`);
  }

  const json = await res.json();
  const url = json?.images?.[0]?.url;
  if (!url) throw new Error("FLUX Kontext returned no image.");
  return { url };
}
