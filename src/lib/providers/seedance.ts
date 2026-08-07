/**
 * Seedance 2.0 / 2.5  ▸  BytePlus ModelArk  (video generation)
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
 * Seedance 2.5 (model id "dreamina-seedance-2-5-260628") is the SAME endpoint
 * family — read from BytePlus's official docs (docs.byteplus.com/en/docs/
 * ModelArk/2607688, /1520757, /1521309) on 2026-08-07 while still unactivated
 * on this account, then CONFIRMED LIVE the same day once it was activated
 * (scripts/probe-seedance-25.ts): a bogus task id returns a proper
 * `{"error":{"code":"ResourceNotFound",...}}` on `/contents/generations/
 * tasks/{id}`, and a real text-to-video run returned `raw.model` matching
 * this exact model id and `usage.total_tokens` in the shape
 * getVideoTask expects (48437 tokens on a 480p/4s clip → $0.52 at the
 * no-video-input rate, computed correctly by computeSeedanceTokenCostCents).
 * So the console's "API support" path, `/v3/contents/generations` with no
 * `/tasks` suffix, is confirmed to just be a truncated label for this same
 * async create+poll surface, not a different/synchronous one. Edit/Extend's
 * ratio/duration constraints (see below) were NOT re-probed — that needs a
 * real source clip; re-probe with `--edit`/`--extend <video-url>` before
 * trusting that half blindly.
 *
 * What's actually different about 2.5:
 *  - 480p/720p only (no 1080p/4K SKU, despite marketing claiming "up to 4K" —
 *    BytePlus's own capability table explicitly denies it).
 *  - Duration 4–30s (vs 2.0's 4–15s).
 *  - Two extra task types beyond plain generation, both selected by content
 *    role + PROMPT WORDING rather than a request field: "Edit" (modify an
 *    attached clip) and "Extend" (continue it forward). Both REQUIRE
 *    ratio:"adaptive" (Edit also requires duration:-1; Extend allows a real
 *    duration or -1) — sending anything else 400s as
 *    InvalidParameter.TaskTypeConstraint, and because task-type
 *    classification happens after the task is queued, that error surfaces
 *    async on the POLL, not on the create call. See createVideoTask's
 *    taskMode handling below.
 *  - Bills by tokens, not by a flat per-second rate: the finished task's poll
 *    response carries `usage.total_tokens`, consumed in
 *    generate/video/status/route.ts via pricing.ts's
 *    computeSeedanceTokenCostCents (same "provider reports its own billing"
 *    pattern as Kling's final_unit_deduction).
 *
 * VIDEO-TO-VIDEO (probe-verified 2026-07-29, scripts/probe-seedance-video-input.ts).
 * A reference clip is another `content` item, and the role is MANDATORY:
 *
 *     { "type": "video_url", "video_url": { "url": "…" }, "role": "reference_video" }
 *
 * Omitting the role is rejected outright — the API answers 400 with
 * "reference media mode requires video role to be reference_video", which is
 * exactly what the image item's optional-role shape would have led us to write.
 * A top-level `video_urls: [...]` array is ALSO accepted, but the content-item
 * form is used here because it carries the role explicitly and matches how
 * every other reference already travels.
 *
 * Limits: at most 3 clips, each 2–15s and ≤50MB. The URL must be fetchable BY
 * BYTEPLUS — our own /api/media/… routes require a session, so callers pass a
 * short-lived presigned URL (storage.getSignedReadUrl).
 *
 * `generate_audio` is a real top-level boolean (re-confirmed against BytePlus's
 * published Seedance 2.0 request shape, 2026-07-29) and is the only audio
 * control any of our video paths has — Higgsfield's MCP Seedance tools expose
 * no audio parameter, and Omni's Interactions request has no audio field. It is
 * surfaced in the composer for this path only (config.ts supportsAudio) and
 * defaults to false, because audio is billed on top of the video.
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
import { buildVideoDirective } from "../video-directive";

/** Instant revert path: SEEDANCE_LEGACY_DIRECTIVE=1 restores the pre-2026-07-28
 *  hand-written directives on BOTH Seedance paths, without a deploy. The new
 *  wording is reasoned rather than bake-off measured (video comparisons cost
 *  real generations), so a one-env-var undo is the honest safety net. */
export function legacyDirective(): boolean {
  return process.env.SEEDANCE_LEGACY_DIRECTIVE === "1";
}

/** The previous directive, kept verbatim for that revert path only. Note the
 *  photoreal-only assumptions ("skin tone and texture", "never beautified")
 *  and the unconditional focus directive — the three faults video-directive.ts
 *  documents and fixes. */
function legacyHeroDirective(refCount: number): string {
  if (!refCount) return "";
  return (
    `IDENTITY LOCK: the reference image${refCount > 1 ? "s" : ""} define ` +
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
  );
}

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
const MODEL_25 =
  process.env.SEEDANCE_MODEL_25 || "dreamina-seedance-2-5-260628";

function pickModel(modelDisplay?: string): string {
  // Checked before mini/fast/lite: "Seedance 2.5" doesn't contain any of
  // those words today, but a hypothetical "Seedance 2.5 Mini" shouldn't fall
  // through to the 2.0 fast SKU if one ever ships.
  if (modelDisplay && /2\.5/.test(modelDisplay)) return MODEL_25;
  if (modelDisplay && /\b(mini|fast|lite)\b/i.test(modelDisplay)) return FAST_MODEL;
  return STANDARD_MODEL;
}

/** Seedance reads "[image N]" references in the prompt. Translate the UI's
 *  @imgN tags so the model binds each tag to the matching reference_image. */
function tagsToImageRefs(prompt: string): string {
  return prompt
    .replace(/@img(\d+)/gi, (_, n) => `[image ${n}]`)
    // Same convention for clips. Unlike the image form this one is NOT
    // probe-verified — reference clips are attached as content items and work
    // without any in-prompt token, so the worst case is the model reading this
    // as ordinary text rather than a broken request.
    .replace(/@vid(\d+)/gi, (_, n) => `[video ${n}]`);
}

export interface SeedanceCreateInput {
  prompt: string;
  modelDisplay?: string; // UI model name, used to pick standard vs fast
  ratio?: string; // "16:9"
  resolution?: string; // "1080p" | "720p" | "480p"
  duration?: number; // seconds
  references?: LabeledRef[]; // tagged reference images (@img1 …)
  /** Publicly fetchable URLs of reference clips (video-to-video). Must already
   *  be signed — this layer does not know about our storage. */
  referenceVideoUrls?: string[];
  /** Ask ModelArk to score the video with a synchronised audio track.
   *  Defaults to false — the historical behaviour, and the safe default since
   *  audio is billed on top of the video. */
  generateAudio?: boolean;
  /** Seedance 2.5 only: "edit"/"extend" an attached clip instead of ordinary
   *  generation. Undefined/"generate" is every other model's only mode. */
  taskMode?: "generate" | "edit" | "extend";
}

export interface SeedanceTaskStatus {
  status: "queued" | "running" | "succeeded" | "failed";
  videoUrl?: string;
  error?: string;
  raw?: unknown;
  /** BytePlus's own token count for the finished task (usage.total_tokens),
   *  used to compute the exact cost — see pricing.ts computeSeedanceTokenCostCents. */
  totalTokens?: number;
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

/**
 * Minimal task-type trigger sentences for Seedance 2.5's Edit/Extend modes
 * (see the file header — BytePlus classifies by content role + these exact
 * kinds of phrases, not a request field). Deliberately NOT run through
 * video-directive.ts: that module's identity-lock/style-follow scaffolding is
 * built for GENERATING a new video from a reference, and this codebase
 * already learned once (video-directive.ts's own header) that stacking
 * unrelated directives contradicts rather than adds — feeding "keep the
 * subject in sharp foreground focus" etc. at an Edit task would compete with
 * the user's actual edit instructions for no benefit. The user's raw prompt
 * carries the instructions; this prefix only has to get BytePlus's
 * classifier to recognize which task type it's looking at.
 */
const EDIT_TRIGGER = "Edit the attached reference video as follows: ";
const EXTEND_TRIGGER = "Extend the attached reference video forward in time: ";

export async function createVideoTask(
  input: SeedanceCreateInput
): Promise<string> {
  const model = pickModel(input.modelDisplay);
  const refs = input.references ?? [];
  const refRole = process.env.SEEDANCE_IMAGE_ROLE || "reference_image";
  const taskMode = input.taskMode ?? "generate";

  // Identity/style scaffolding now lives in lib/video-directive.ts, shared with
  // the Higgsfield path so the two cannot drift apart again. It also assembles
  // the whole text (scaffolding, prompt verbatim, then the precedence rule),
  // because the closing rule has to land AFTER the prompt — which the old
  // `directive + prompt` shape made impossible.
  //
  // Edit/Extend skip it entirely — see the trigger-sentence comment above.
  let text: string;
  if (taskMode === "edit") {
    text = EDIT_TRIGGER + tagsToImageRefs(input.prompt.trim());
  } else if (taskMode === "extend") {
    text = EXTEND_TRIGGER + tagsToImageRefs(input.prompt.trim());
  } else {
    text = legacyDirective()
      ? legacyHeroDirective(refs.length) + tagsToImageRefs(input.prompt.trim())
      : buildVideoDirective({
          prompt: tagsToImageRefs(input.prompt.trim()),
          refCount: refs.length,
          tagSyntax: "bracket",
        });
  }

  const content: Array<Record<string, unknown>> = [{ type: "text", text }];
  refs.forEach((ref) => {
    content.push({
      type: "image_url",
      image_url: { url: ref.dataUrl },
      role: refRole,
    });
  });
  // `role` is required here, unlike on image items — see the header. Capped at
  // the documented 3 rather than letting the provider reject the whole request.
  for (const url of (input.referenceVideoUrls ?? []).slice(0, 3)) {
    content.push({
      type: "video_url",
      video_url: { url },
      role: "reference_video",
    });
  }

  const body: Record<string, unknown> = {
    model,
    content,
    // Was hardcoded false. Still defaults to false when the caller says
    // nothing, so nothing starts paying for audio it did not ask for.
    generate_audio: input.generateAudio === true,
  };
  if (taskMode === "edit" || taskMode === "extend") {
    // BOTH task types require ratio:"adaptive" (output follows the source
    // clip's own aspect ratio) — sending the UI's own aspectRatio here would
    // 400 as InvalidParameter.TaskTypeConstraint, reported async on the next
    // poll rather than on this create call, because classification happens
    // after the task is already queued. Edit additionally requires
    // duration:-1 (output matches the source's length); Extend allows a real
    // duration if the caller gave one.
    body.ratio = "adaptive";
    body.duration = taskMode === "edit" ? -1 : input.duration || -1;
  } else {
    if (input.ratio) body.ratio = input.ratio;
    if (input.duration) body.duration = input.duration;
  }
  if (input.resolution) body.resolution = input.resolution;

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

  // Seedance 2.5 only (2.0's response has no `usage` object) — see the file
  // header and pricing.ts computeSeedanceTokenCostCents.
  const totalTokensRaw = json?.usage?.total_tokens;
  const totalTokens =
    typeof totalTokensRaw === "number" && Number.isFinite(totalTokensRaw)
      ? totalTokensRaw
      : undefined;

  return { status, videoUrl, error, raw: json, totalTokens };
}
