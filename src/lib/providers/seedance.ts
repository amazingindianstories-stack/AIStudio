/**
 * Seedance 2.0  ▸  BytePlus ModelArk  (video generation)
 * Async task API: create a task, then poll until it succeeds.
 *
 * Verified against ModelArk Seedance 2.0:
 *   POST {base}/contents/generations/tasks
 *   {
 *     "model": "dreamina-seedance-2-0-260128",
 *     "content": [
 *       { "type": "text", "text": "... use [image 1] as the subject ..." },
 *       { "type": "image_url", "image_url": { "url": "..." }, "role": "reference_image" }
 *     ],
 *     "ratio": "16:9", "resolution": "1080p", "duration": 5, "generate_audio": false
 *   }
 *
 * Notes that previously broke this:
 *  - Seedance 1.0 models do NOT support reference-to-video (r2v) — must use 2.0.
 *  - ratio/resolution/duration are TOP-LEVEL JSON fields, not "--flag" text.
 *  - Seedance refers to images in the prompt as "[image 1]", not "@img1".
 *  - first/last-frame content cannot be mixed with reference_image media.
 *
 * Key lives in ARK_API_KEY (server-only).
 * Docs: https://docs.byteplus.com/en/docs/ModelArk/1520757
 */

import type { LabeledRef } from "../mentions";

/** Error carrying a machine-readable code so callers can branch (e.g. offer a
 *  text-to-video retry when a reference image is rejected by moderation). */
export class SeedanceError extends Error {
  code: string;
  status?: number;
  constructor(message: string, code = "seedance_error", status?: number) {
    super(message);
    this.name = "SeedanceError";
    this.code = code;
    this.status = status;
  }
}

function arkBase() {
  return (
    process.env.ARK_BASE_URL || "https://ark.ap-southeast.bytepluses.com/api/v3"
  ).replace(/\/$/, "");
}

function arkKey() {
  const key = process.env.ARK_API_KEY;
  if (!key) {
    throw new Error(
      "ARK_API_KEY is not set. Add it to .env.local (Seedance / BytePlus ModelArk)."
    );
  }
  return key;
}

const STANDARD_MODEL =
  process.env.SEEDANCE_MODEL || "dreamina-seedance-2-0-260128";
const FAST_MODEL =
  process.env.SEEDANCE_MODEL_FAST || "dreamina-seedance-2-0-fast-260128";

function pickModel(modelDisplay?: string): string {
  if (modelDisplay && /\b(mini|fast|lite)\b/i.test(modelDisplay)) return FAST_MODEL;
  return STANDARD_MODEL;
}

/** Seedance reads "[image N]" references in the prompt. Translate the UI's
 *  @imgN tags so the model binds each tag to the matching reference_image. */
function tagsToImageRefs(prompt: string): string {
  return prompt.replace(/@img(\d+)/gi, (_, n) => `[image ${n}]`);
}

export interface SeedanceCreateInput {
  prompt: string;
  modelDisplay?: string; // UI model name, used to pick standard vs fast
  ratio?: string; // "16:9"
  resolution?: string; // "1080p" | "720p" | "480p"
  duration?: number; // seconds
  references?: LabeledRef[]; // tagged reference images (@img1 …)
}

export interface SeedanceTaskStatus {
  status: "queued" | "running" | "succeeded" | "failed";
  videoUrl?: string;
  error?: string;
  raw?: unknown;
}

export const MODERATION_MESSAGE =
  "BytePlus rejected the reference image — its privacy / anti-deepfake filter flags photorealistic faces (it can't tell an AI-generated face from a real one). Retry as text-to-video, or use a clearly stylized reference.";

/** Whether an error code/message looks like a BytePlus moderation rejection. */
export function isModerationMessage(text: string): boolean {
  return /SensitiveContent|Privacy|real person|portrait|sensitive/i.test(
    text || ""
  );
}

/** Turn raw ModelArk error bodies into a typed, UI-friendly SeedanceError. */
function friendlyError(status: number, body: string): SeedanceError {
  let code = "";
  let message = "";
  try {
    const j = JSON.parse(body);
    code = j?.error?.code || "";
    message = j?.error?.message || "";
  } catch {
    /* not JSON */
  }
  if (isModerationMessage(code + message)) {
    return new SeedanceError(MODERATION_MESSAGE, "moderation", status);
  }
  if (code)
    return new SeedanceError(
      `Seedance error (${status} ${code}): ${message || body.slice(0, 300)}`,
      "seedance_error",
      status
    );
  return new SeedanceError(
    `Seedance create error ${status}: ${body.slice(0, 400)}`,
    "seedance_error",
    status
  );
}

export async function createVideoTask(
  input: SeedanceCreateInput
): Promise<string> {
  const model = pickModel(input.modelDisplay);
  const refs = input.references ?? [];
  const refRole = process.env.SEEDANCE_IMAGE_ROLE || "reference_image";

  // When a reference is given, lead with a strict main-character directive so
  // the hero's identity holds in crowded shots instead of being diluted across
  // every face. Crowd faces are explicitly anonymised and de-emphasised.
  const heroDirective = refs.length
    ? `IDENTITY LOCK: the reference image${refs.length > 1 ? "s" : ""} define ` +
      `the MAIN CHARACTER's exact, fixed appearance. In EVERY frame keep this ` +
      `exact same person — identical face (bone structure, jawline, hairline, ` +
      `eye shape and color, eyebrows, nose, lips, skin tone and texture with ` +
      `its moles/scars/freckles, facial hair, apparent age), plus the same ` +
      `hairstyle, body build and worn outfit/jewelry unless the prompt ` +
      `explicitly changes them — unmistakably the SAME individual, never a ` +
      `lookalike, never beautified or idealized, with zero identity or ` +
      `wardrobe drift between frames. Keep the main character in sharp ` +
      `foreground focus as the clear focal point. Every other person (crowd, ` +
      `bystanders, dancers, background figures) is a DIFFERENT anonymous ` +
      `individual who must NOT share or resemble the main character's face; ` +
      `render the crowd softer and out of focus so it never competes with or ` +
      `is mistaken for the main character. Never duplicate the main character. ` +
      `LITERAL PROMPT: execute the prompt exactly as written — every stated ` +
      `subject, count, wardrobe item, color, action, camera move and lighting ` +
      `appears precisely as specified; add nothing, drop nothing, reinterpret ` +
      `nothing. Anything under "NEGATIVE PROMPT" or phrased as "no …" is ` +
      `strictly forbidden in every frame. `
    : "";

  const content: Array<Record<string, unknown>> = [
    { type: "text", text: heroDirective + tagsToImageRefs(input.prompt.trim()) },
  ];
  refs.forEach((ref) => {
    content.push({
      type: "image_url",
      image_url: { url: ref.dataUrl },
      role: refRole,
    });
  });

  const body: Record<string, unknown> = {
    model,
    content,
    generate_audio: false,
  };
  if (input.ratio) body.ratio = input.ratio;
  if (input.resolution) body.resolution = input.resolution;
  if (input.duration) body.duration = input.duration;

  const res = await fetch(`${arkBase()}/contents/generations/tasks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${arkKey()}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw friendlyError(res.status, text);
  }
  const json = await res.json();
  const id = json?.id || json?.task_id || json?.data?.id;
  if (!id) throw new Error("Seedance create: no task id in response.");
  return id;
}

export async function getVideoTask(
  taskId: string
): Promise<SeedanceTaskStatus> {
  const res = await fetch(
    `${arkBase()}/contents/generations/tasks/${encodeURIComponent(taskId)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${arkKey()}` },
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Seedance poll error ${res.status}: ${text.slice(0, 500)}`);
  }
  const json = await res.json();

  // ModelArk statuses: queued | running | succeeded | failed | cancelled
  const rawStatus: string = (json?.status || "").toLowerCase();
  let status: SeedanceTaskStatus["status"] = "running";
  if (rawStatus === "succeeded") status = "succeeded";
  else if (rawStatus === "failed" || rawStatus === "cancelled") status = "failed";
  else if (rawStatus === "queued") status = "queued";

  const videoUrl =
    json?.content?.video_url ||
    json?.content?.[0]?.video_url ||
    json?.video_url;

  const error =
    status === "failed"
      ? json?.error?.message || json?.error || "Generation failed"
      : undefined;

  return { status, videoUrl, error, raw: json };
}
