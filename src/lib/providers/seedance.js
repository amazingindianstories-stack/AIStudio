

import { buildVideoDirective } from "../video-directive";
import { parseRefRoles } from "../shot-spec";

/** Instant revert path: SEEDANCE_LEGACY_DIRECTIVE=1 restores the pre-2026-07-28
 *  hand-written directives on BOTH Seedance paths, without a deploy. The new
 *  wording is reasoned rather than bake-off measured (video comparisons cost
 *  real generations), so a one-env-var undo is the honest safety net. */
export function legacyDirective() {
  return process.env.SEEDANCE_LEGACY_DIRECTIVE === "1";
}

/** The previous directive, kept verbatim for that revert path only. Note the
 *  photoreal-only assumptions ("skin tone and texture", "never beautified")
 *  and the unconditional focus directive — the three faults video-directive.ts
 *  documents and fixes. */
function legacyHeroDirective(refCount) {
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
  code;
  status;
  constructor(message, code = "seedance_error", status) {
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

function pickModel(modelDisplay) {
  // Checked before mini/fast/lite: "Seedance 2.5" doesn't contain any of
  // those words today, but a hypothetical "Seedance 2.5 Mini" shouldn't fall
  // through to the 2.0 fast SKU if one ever ships.
  if (modelDisplay && /2\.5/.test(modelDisplay)) return MODEL_25;
  if (modelDisplay && /\b(mini|fast|lite)\b/i.test(modelDisplay)) return FAST_MODEL;
  return STANDARD_MODEL;
}

/** Per-reference role hint for buildVideoDirective's legend (2026-08-17,
 *  video-directive.ts "PER-REFERENCE ROLE LEGEND"). `refs` is whatever was
 *  actually resolved onto this request (resolveReferences' tagged subset, or
 *  everything when the prompt tags nothing) — each entry already carries its
 *  own `@imgN` tag and 1-based original `index`, so this only has to look up
 *  each attached ref's role and key the map by that same original index,
 *  which is exactly the number `tagsToImageRefs` prints as "[image N]". No
 *  vision call: parseRefRoles is the same free keyword scan the image path
 *  already runs. Returns undefined (not an empty Map) when nothing is
 *  resolvable, so buildVideoDirective's own `refRoles` default takes over. */
function buildRefRoles(refs, rawPrompt) {
  if (!refs.length) return undefined;
  const roleByTag = parseRefRoles(rawPrompt);
  if (!roleByTag.size) return undefined;
  const map = new Map();
  for (const ref of refs) {
    const role = roleByTag.get(ref.tag);
    if (role) map.set(ref.index, role);
  }
  return map.size ? map : undefined;
}

/** Seedance reads "[image N]" references in the prompt. Translate the UI's
 *  @imgN tags so the model binds each tag to the matching reference_image. */
function tagsToImageRefs(prompt) {
  return prompt
    .replace(/@img(\d+)/gi, (_, n) => `[image ${n}]`)
    // Same convention for clips. Unlike the image form this one is NOT
    // probe-verified — reference clips are attached as content items and work
    // without any in-prompt token, so the worst case is the model reading this
    // as ordinary text rather than a broken request.
    .replace(/@vid(\d+)/gi, (_, n) => `[video ${n}]`);
}

export const MODERATION_MESSAGE =
  "BytePlus rejected the reference image — its privacy / anti-deepfake filter flags photorealistic faces (it can't tell an AI-generated face from a real one). Retry as text-to-video, or use a clearly stylized reference.";

/** Whether an error code/message looks like a BytePlus moderation rejection. */
export function isModerationMessage(text) {
  return /SensitiveContent|Privacy|real person|portrait|sensitive/i.test(
    text || ""
  );
}

/** Turn raw ModelArk error bodies into a typed, UI-friendly SeedanceError. */
function friendlyError(status, body) {
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
  input
) {
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
  let text;
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
          refRoles: buildRefRoles(refs, input.prompt),
        });
  }

  const content = [{ type: "text", text }];
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

  const body = {
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
  taskId
) {
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
  const rawStatus = (json?.status || "").toLowerCase();
  let status = "running";
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
