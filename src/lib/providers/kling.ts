import sharp from "sharp";

/**
 * Kling image generation (Kuaishou / KlingAI Open Platform).
 *
 * Contract below was read from the official docs on 2026-07-30 and the auth
 * scheme verified live against the account key. The docs are a JS-rendered SPA
 * that returns HTTP 446 to plain fetchers, so re-reading them needs a real
 * browser — `scripts/probe-kling-image.ts` is the cheaper way to re-verify.
 *
 * AUTH — a single API Key sent as `Authorization: Bearer <key>`.
 *   Kling's older docs (and most third-party write-ups) describe an
 *   AccessKey/SecretKey pair signed into a short-lived HS256 JWT per request.
 *   That path still exists but is explicitly labelled "API only applicable to
 *   legacy version design standards". The current scheme is a plain key, which
 *   is what `KLING_API` is. Don't reintroduce the JWT dance.
 *   Verified: GET /v1/images/generations?pageNum=1&pageSize=1 → {"code":0}.
 *
 * HOST — `https://api-singapore.klingai.com`. The docs carry an explicit notice
 *   that the endpoint moved from api.klingai.com and that the singapore host is
 *   the one for servers outside China (i.e. ours). Both answered our key when
 *   probed; we use the documented one. `KLING_API_HOST` overrides.
 *
 * ONE REFERENCE IMAGE, NOT MANY — this is the important limitation for this app.
 *   `POST /v1/images/generations` has a single scalar `image` field. Multi-image
 *   reference lives on a *different* endpoint, `POST /v1/images/omni-image`,
 *   which takes an `image_list[]` and only accepts `kling-v3-omni` /
 *   `kling-image-o1` — neither of which is one of the two models wired up here.
 *   The capability map's "free multi-reference images" blurb for Kling Image 3.0
 *   refers to that endpoint, not this one; the same map's "Multi-image to Image"
 *   row is "—" for kling-v3, which is what actually governs.
 *   So: >1 resolved reference is a loud error, never a silent drop of the extras
 *   (see the image-cap precedent in gemini.ts).
 *
 * PER-MODEL CAPABILITIES (from the Image Capability Map, 2026-07-30):
 *   kling-v3   (Kling Image 3.0) — text→image, image→image, 1K/2K, 8 ratios
 *   kling-v2-1 (Kling Image 2.1) — text→image, image→image, 1K/2K, 8 ratios
 *   Neither supports 4K (that is kling-v3-omni only), so a 4K request errors
 *   rather than quietly returning 2K under a 4K label.
 *
 * PARAMETERS WE DELIBERATELY DO NOT SEND:
 *   - `negative_prompt`: documented as unsupported whenever `image` is non-empty.
 *     Rather than send it in one mode and not the other, we never send it — the
 *     shot-spec system already puts its NEGATIVE block inside the prompt text.
 *   - `image_reference` / `image_fidelity` / `human_fidelity`: the endpoint doc
 *     scopes these to kling-v1 / kling-v1-5 only. The capability map does show
 *     "Character/Face Feature Reference" for kling-v2-1, so these two sources
 *     disagree; omitting them is the safe reading, since sending a parameter a
 *     model doesn't accept risks a 400 while omitting it only forgoes a knob.
 *     Probe before adding them.
 *   - `element_list`: needs the Element Library (uploaded, managed elements),
 *     which this app has no concept of.
 *
 * RESULTS EXPIRE after 30 days per the docs, so the caller must re-store the
 * bytes locally — which is what saveFromUrl does for every provider here.
 *
 * `aspect_ratio` IS IGNORED IN IMAGE-TO-IMAGE — probe-measured 2026-07-30, and
 * not stated anywhere in Kling's docs or capability map. With one 800×600 (4:3)
 * reference:
 *     requested 1:1   → 1168×864 (1.352)
 *     requested 21:9  → 1168×864 (1.352)   ← byte-identical dimensions
 * i.e. the output follows the reference's shape and the requested ratio has no
 * effect. Text-to-image does honour it (16:9 → 2720×1536 = 1.771).
 *
 * This matters beyond a wrong label: `generations.aspectRatio` is what the
 * library grid uses to lay out each card (packColumns in AssetGrid), so storing
 * the *requested* ratio would both mislabel the card and give it the wrong shape
 * in the masonry. The caller therefore measures the returned image and stores
 * the real ratio — see nearestKlingAspectRatio and the kling branch of
 * /api/queue/execute.
 */

const DEFAULT_HOST = "https://api-singapore.klingai.com";

/** Kling's hard prompt cap. Documented for both `prompt` and `negative_prompt`. */
export const KLING_PROMPT_MAX = 2500;

/** Reference-image rules from the endpoint doc: formats jpg/jpeg/png, ≤10MB,
 *  min 300px on a side, aspect ratio between 1:2.5 and 2.5:1. */
const REF_MAX_BYTES = 10 * 1024 * 1024;
const REF_MIN_DIM = 300;
const REF_MAX_ASPECT = 2.5;

export interface KlingModelSpec {
  /** Wire value for `model_name`. */
  modelName: string;
  /** Display name in MODELS / the pricing table. */
  display: string;
  resolutions: readonly string[];
  aspectRatios: readonly string[];
}

/**
 * The two models exposed in the UI. Keyed by display name because that is what
 * `GenerationItem.model` carries and what the pricing table is keyed on.
 */
export const KLING_MODELS: readonly KlingModelSpec[] = [
  {
    modelName: "kling-v3",
    display: "Kling Image 3.0",
    resolutions: ["1K", "2K"],
    aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", "21:9"],
  },
  {
    modelName: "kling-v2-1",
    display: "Kling Image 2.1",
    resolutions: ["1K", "2K"],
    aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", "21:9"],
  },
];

export function isKlingModel(model: string): boolean {
  return /^kling\b/i.test(model.trim());
}

export function klingSpec(model: string): KlingModelSpec | undefined {
  const wanted = model.trim().toLowerCase();
  return KLING_MODELS.find((m) => m.display.toLowerCase() === wanted);
}

/**
 * The label from Kling's supported set that best describes real pixel
 * dimensions.
 *
 * Needed because Kling ignores `aspect_ratio` in image-to-image (see the header)
 * AND because even in text-to-image it rounds to convenient pixel multiples —
 * 16:9 comes back as 2720×1536, which is 1.771 rather than 1.778. So an exact
 * string match would never hit; the nearest ratio by log-distance is the right
 * comparison, since ratio error is multiplicative (4:3 vs 3:2 should be as
 * "far" as 3:4 vs 2:3).
 */
export function nearestKlingAspectRatio(width: number, height: number): string | undefined {
  if (!width || !height) return undefined;
  const target = Math.log(width / height);
  let best: string | undefined;
  let bestDelta = Infinity;
  // Any Kling model's set is the same list; use the first spec's.
  for (const label of KLING_MODELS[0].aspectRatios) {
    const [w, h] = label.split(":").map(Number);
    if (!w || !h) continue;
    const delta = Math.abs(Math.log(w / h) - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = label;
    }
  }
  return best;
}

function apiKey(): string {
  const key = process.env.KLING_API;
  if (!key) {
    throw new Error(
      "KLING_API is not set, so Kling models cannot be called. Create an API " +
        "key in the Kling console and set KLING_API."
    );
  }
  return key;
}

function host(): string {
  return (process.env.KLING_API_HOST || DEFAULT_HOST).replace(/\/$/, "");
}

export interface KlingImageInput {
  /** Display name, e.g. "Kling Image 3.0". */
  model: string;
  prompt: string;
  aspectRatio?: string;
  /** App-side "1K" | "2K" | "4K". */
  resolution?: string;
  /**
   * At most one reference image. More than one is rejected rather than trimmed —
   * see the header. Base64 payloads only (no data: prefix); the caller has
   * already read the stored object.
   */
  references?: { mimeType: string; data: string }[];
}

export interface KlingCreatePayload {
  model_name: string;
  prompt: string;
  n: number;
  aspect_ratio: string;
  resolution: string;
  image?: string;
}

/**
 * Build the create-task body. Pure and exported so the parameter gating is
 * unit-testable without spending money — every rule here came from the docs
 * rather than from trying it.
 */
export function buildKlingPayload(input: KlingImageInput): KlingCreatePayload {
  const spec = klingSpec(input.model);
  if (!spec) {
    throw new Error(
      `${input.model} is not a Kling model this app knows. Known: ` +
        KLING_MODELS.map((m) => m.display).join(", ")
    );
  }

  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("Prompt is required.");
  if (prompt.length > KLING_PROMPT_MAX) {
    // Loud rather than truncated: silently cutting a prompt would drop scene
    // detail the user wrote and make the result inexplicable. Prompts here can
    // reach 18 kB, so this will fire on the long shot-spec ones.
    throw new Error(
      `${spec.display} accepts prompts up to ${KLING_PROMPT_MAX} characters; ` +
        `this one is ${prompt.length}. Shorten the prompt (or use Nano Banana ` +
        `Pro, which has no such limit).`
    );
  }

  const references = input.references ?? [];
  if (references.length > 1) {
    throw new Error(
      `${spec.display} accepts one reference image; ${references.length} were ` +
        `provided. Kling's multi-reference model is Kling Image 3.0 Omni on a ` +
        `separate endpoint, which is not wired up yet — use Nano Banana Pro for ` +
        `multi-reference work, or reduce this to a single @tag.`
    );
  }

  const resolution = input.resolution ?? "1K";
  if (!spec.resolutions.includes(resolution)) {
    throw new Error(
      `${spec.display} supports ${spec.resolutions.join("/")} only; ` +
        `${resolution} was requested. (4K is Kling Image 3.0 Omni only.)`
    );
  }

  const aspectRatio = input.aspectRatio ?? "1:1";
  if (!spec.aspectRatios.includes(aspectRatio)) {
    throw new Error(
      `${spec.display} does not support ${aspectRatio}. Supported: ` +
        spec.aspectRatios.join(", ")
    );
  }

  return {
    model_name: spec.modelName,
    prompt,
    // One image per generation row. Kling accepts n up to 9, but this app's
    // unit of work — and of billing — is one row per image.
    n: 1,
    aspect_ratio: aspectRatio,
    // Wire values are lowercase.
    resolution: resolution.toLowerCase(),
    ...(references.length ? { image: references[0].data } : {}),
  };
}

/**
 * Coerce a stored reference into something Kling will accept: JPEG or PNG,
 * ≥300px, ≤10MB, aspect ratio within 1:2.5–2.5:1.
 *
 * The app's own uploads allow WebP (see storage.splitDataUrl), which Kling does
 * not, so this cannot be skipped. Violations that re-encoding can't fix — too
 * small, too elongated — are errors, because the alternative is upscaling or
 * cropping the user's reference without being asked.
 */
export async function prepKlingReference(
  mimeType: string,
  base64: string
): Promise<{ mimeType: string; data: string }> {
  const buf = Buffer.from(base64, "base64");
  const meta = await sharp(buf).metadata();
  const { width, height, format } = meta;
  if (!width || !height) {
    throw new Error("The reference image could not be read.");
  }
  if (Math.min(width, height) < REF_MIN_DIM) {
    throw new Error(
      `Kling needs reference images at least ${REF_MIN_DIM}px on both sides; ` +
        `this one is ${width}×${height}.`
    );
  }
  const aspect = width / height;
  if (aspect > REF_MAX_ASPECT || aspect < 1 / REF_MAX_ASPECT) {
    throw new Error(
      `Kling needs a reference aspect ratio between 1:2.5 and 2.5:1; this one ` +
        `is ${width}×${height}.`
    );
  }

  let out = buf;
  let outMime = mimeType;
  // Re-encode anything that isn't already jpeg/png, and anything still over the
  // size ceiling. JPEG at q90 is the smaller of the two accepted formats.
  const accepted = format === "jpeg" || format === "png";
  if (!accepted || out.byteLength > REF_MAX_BYTES) {
    out = await sharp(buf).jpeg({ quality: 90 }).toBuffer();
    outMime = "image/jpeg";
  }
  if (out.byteLength > REF_MAX_BYTES) {
    // Still too big after re-encoding: scale down rather than fail, since this
    // changes no content, only pixel count.
    out = await sharp(out)
      .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
  }
  if (out.byteLength > REF_MAX_BYTES) {
    throw new Error(
      `The reference image is ${(out.byteLength / 1024 / 1024).toFixed(1)}MB ` +
        `after compression; Kling's limit is 10MB.`
    );
  }
  return { mimeType: outMime, data: out.toString("base64") };
}

interface KlingEnvelope<T> {
  code: number;
  message: string;
  request_id?: string;
  data: T;
}

interface KlingTask {
  task_id: string;
  task_status: "submitted" | "processing" | "succeed" | "failed";
  task_status_msg?: string;
  final_unit_deduction?: string;
  task_result?: { images?: { index: number; url: string }[] };
}

async function klingFetch<T>(
  path: string,
  init?: RequestInit
): Promise<KlingEnvelope<T>> {
  const res = await fetch(`${host()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let json: KlingEnvelope<T> | undefined;
  try {
    json = JSON.parse(text) as KlingEnvelope<T>;
  } catch {
    // Non-JSON means an edge/proxy error, not the API — surface the status.
    throw new Error(
      `Kling returned a non-JSON ${res.status} response: ${text.slice(0, 300)}`
    );
  }
  // Kling signals failure both ways: an HTTP status AND a non-zero `code`, and
  // a 200 with code!=0 happens, so checking res.ok alone is not enough.
  if (!res.ok || json.code !== 0) {
    throw new Error(
      `Kling ${path} failed (http ${res.status}, code ${json.code}): ${
        json.message || "no message"
      }`
    );
  }
  return json;
}

export async function createKlingImageTask(input: KlingImageInput): Promise<string> {
  const payload = buildKlingPayload(input);
  const json = await klingFetch<KlingTask>("/v1/images/generations", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const taskId = json.data?.task_id;
  if (!taskId) throw new Error("Kling accepted the request but returned no task_id.");
  return taskId;
}

export async function getKlingImageTask(taskId: string): Promise<KlingTask> {
  const json = await klingFetch<KlingTask>(
    `/v1/images/generations/${encodeURIComponent(taskId)}`
  );
  return json.data;
}

export interface KlingImageResult {
  /** Kling-hosted URL. Expires after 30 days — re-store it. */
  url: string;
  /** Kling's own billed unit count, when it reports one. Logged so the pricing
   *  row can be calibrated against what Kling actually charged. */
  unitDeduction?: string;
}

/**
 * Create a task and poll it to completion.
 *
 * Docs put image generation at 20–60s. The ceiling here is deliberately below
 * this route's maxDuration so a hung task surfaces as our timeout message
 * rather than as the invocation being killed with the row stranded in `running`.
 */
export async function generateImageKling(
  input: KlingImageInput,
  opts: { timeoutMs?: number; pollMs?: number } = {}
): Promise<KlingImageResult> {
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const pollMs = opts.pollMs ?? 3_000;

  const taskId = await createKlingImageTask(input);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const task = await getKlingImageTask(taskId);
    if (task.task_status === "succeed") {
      const url = task.task_result?.images?.[0]?.url;
      if (!url) {
        throw new Error("Kling reported success but returned no image URL.");
      }
      return { url, unitDeduction: task.final_unit_deduction };
    }
    if (task.task_status === "failed") {
      throw new Error(
        task.task_status_msg
          ? `Kling generation failed: ${task.task_status_msg}`
          : "Kling generation failed with no reason given."
      );
    }
  }
  throw new Error(
    `Kling task ${taskId} did not finish within ${Math.round(timeoutMs / 1000)}s.`
  );
}
