import sharp from "sharp";
import { abortableDelay } from "../queue-execution-deadline";

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
 * PER-MODEL CAPABILITIES (Image Capability Map, re-read live 2026-08-17):
 *   kling-v3   (Kling Image 3.0) — text→image, image→image, 1K/2K, 8 ratios
 *   kling-v2-1 (Kling Image 2.1) — text→image, image→image, 1K/2K, 8 ratios,
 *                                  but 2K only WITHOUT a reference image —
 *                                  measured, undocumented. See RESOLUTION.
 *   Neither supports 4K (that is kling-v3-omni only), so a 4K request errors
 *   rather than quietly returning 2K under a 4K label.
 *
 * RESOLUTION: 2K ON kling-v2-1 IS CONDITIONAL ON THERE BEING NO REFERENCE.
 *   `resolution: "2k"` on kling-v2-1 returns
 *       http 400, code 1201: resolution value '2k' is not supported
 *   *when an `image` is attached*, but works fine without one. Measured from
 *   this app's own generation history, which is why the restriction is scoped
 *   to the reference rather than to the model:
 *       2026-07-30  v2-1  2K  refs=0  → succeeded ×4
 *       2026-08-17  v2-1  2K  refs=1  → failed ×2 (code 1201)
 *   Every success had no reference; both failures had one, and there is no
 *   counter-example either way. kling-v3 does 2K with a reference happily
 *   (2026-08-12/13/17), so it is the way forward for 2K reference work.
 *
 *   An earlier fix for this made it model-wide (`resolutions: ["1K"]`) on the
 *   strength of the 08-17 failures alone. That was wrong — it would have
 *   broken 2K text-to-image on 2.1, a configuration with four successful rows
 *   behind it. Don't re-narrow it without checking the history again.
 *
 *   THE DOCS AGREE THAT 2.1 DOES 2K, and that was checked properly rather
 *   than assumed — read live in a real browser on 2026-08-17, since the docs
 *   answer plain fetchers with 446. What no doc mentions is the reference
 *   condition:
 *     - The Capability Map (/document-api/guides/capability-map/image) is the
 *       per-model authority every parameter page defers to, and its Resolution
 *       row grants 2.1 both 1K and 2K (3.0=1K,2K · 3.0 Omni=1K,2K,4K ·
 *       O1=1K,2K · 2.1=1K,2K · 2.0 New=1K). Do not rewrite this comment to say
 *       the map only allows 1K there — it does not.
 *     - The per-version API pages are shared boilerplate and prove nothing
 *       per-model: every block says "Different model versions support varying
 *       ranges — refer to the Capability Map", and the 3.0 Omni page documents
 *       /v1/images/generations, omits kling-v3-omni from its own model_name
 *       enum, and lists resolution 1k|2k with no 4K — for the one model the
 *       map grants 4K.
 *     - 1201 is documented as plain parameter validation ("Invalid parameters,
 *       such as an incorrect key or invalid value"), NOT plan/quota gating.
 *   So the reference condition is undocumented behaviour, and refusing it
 *   locally turns a wasted round-trip and a failed row into an instant error.
 *
 *   STILL UNCONFIRMED AGAINST A LIVE PROBE: the history is a natural
 *   experiment, not a controlled one — nothing rules out a Kling-side change
 *   between 07-30 and 08-17 that took 2K away from v2-1 entirely and would
 *   also fit these rows. probe-kling-image.js distinguishes the two live and
 *   for free (every model × 1k/2k × t2i/i2i with n=99 against a max of 9, so
 *   nothing is ever created) and its two checks name the exact edit to make
 *   in either direction. Run it before widening or narrowing this.
 *
 *   Note the wire casing is NOT the problem: lowercase `2k` is exactly what
 *   kling-v3 accepts. Don't "fix" this by sending "2K".
 *
 * PARAMETERS WE DELIBERATELY DO NOT SEND:
 *   - `negative_prompt`: documented as unsupported whenever `image` is non-empty.
 *     Rather than send it in one mode and not the other, we never send it — the
 *     shot-spec system already puts its NEGATIVE block inside the prompt text.
 *   - `image_reference` / `image_fidelity` / `human_fidelity`: RE-READ LIVE on
 *     2026-08-17 on the Kling Image 2.1 page itself, and the scoping is still
 *     v1/v1-5 in Kling's own words — `image_reference` is "Required when using
 *     kling-v1-5 and image parameter is not empty", `image_fidelity` is "Only
 *     kling-v1, kling-v1-5 support this parameter". The Capability Map does
 *     show ✓ for Character/Face Feature Reference on 2.1, so the two sources
 *     still disagree (the same pattern as the 2K row), and omitting remains the
 *     safe reading: sending a parameter a model doesn't accept risks a 400,
 *     omitting it only forgoes a knob. Whatever the map's ✓ refers to, it is
 *     not these three fields on this endpoint.
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

/**
 * The two models exposed in the UI. Keyed by display name because that is what
 * `GenerationItem.model` carries and what the pricing table is keyed on.
 */
export const KLING_MODELS = [
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
    // …but 2K only WITHOUT a reference image. See the RESOLUTION note in the
    // header; this is measured from our own history, not assumed.
    twoKNeedsNoReference: true,
    aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", "21:9"],
  },
];

export function isKlingModel(model) {
  return /^kling\b/i.test(model.trim());
}

export function klingSpec(model) {
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
export function nearestKlingAspectRatio(width, height) {
  if (!width || !height) return undefined;
  const target = Math.log(width / height);
  let best;
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

function apiKey() {
  const key = process.env.KLING_API;
  if (!key) {
    throw new Error(
      "KLING_API is not set, so Kling models cannot be called. Create an API " +
        "key in the Kling console and set KLING_API."
    );
  }
  return key;
}

function host() {
  return (process.env.KLING_API_HOST || DEFAULT_HOST).replace(/\/$/, "");
}

/**
 * Build the create-task body. Pure and exported so the parameter gating is
 * unit-testable without spending money — every rule here came from the docs
 * rather than from trying it.
 */
export function buildKlingPayload(input) {
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
    // Name the model that CAN do what was asked, rather than only what this one
    // can't — 2K and 4K have different answers and the old single parenthetical
    // pointed a 2K-on-2.1 request at Omni, which is not where 2K lives.
    const where =
      resolution === "2K"
        ? " Use Kling Image 3.0 for 2K."
        : resolution === "4K"
        ? " 4K is Kling Image 3.0 Omni only, which is not wired up here."
        : "";
    throw new Error(
      `${spec.display} supports ${spec.resolutions.join("/")} only; ` +
        `${resolution} was requested.${where}`
    );
  }
  if (spec.twoKNeedsNoReference && resolution === "2K" && references.length) {
    throw new Error(
      `${spec.display} cannot render 2K from a reference image — Kling rejects ` +
        `it with "resolution value '2k' is not supported". Drop to 1K, remove ` +
        `the reference, or use Kling Image 3.0, which does 2K with a reference.`
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
  mimeType,
  base64
) {
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

async function klingFetch(
  path,
  init,
  signal
) {
  const res = await fetch(`${host()}${path}`, {
    ...init,
    signal,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text) ;
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

export async function createKlingImageTask(input, opts = {}) {
  const payload = buildKlingPayload(input);
  const json = await klingFetch("/v1/images/generations", {
    method: "POST",
    body: JSON.stringify(payload),
  }, opts.signal);
  const taskId = json.data?.task_id;
  if (!taskId) throw new Error("Kling accepted the request but returned no task_id.");
  return taskId;
}

export async function getKlingImageTask(taskId, opts = {}) {
  const json = await klingFetch(
    `/v1/images/generations/${encodeURIComponent(taskId)}`,
    undefined,
    opts.signal
  );
  return json.data;
}

/**
 * Create a task and poll it to completion.
 *
 * Docs put image generation at 20–60s. The ceiling here is deliberately below
 * this route's maxDuration so a hung task surfaces as our timeout message
 * rather than as the invocation being killed with the row stranded in `running`.
 */
export async function generateImageKling(
  input,
  opts = {}
) {
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const pollMs = opts.pollMs ?? 3_000;

  const taskId = await createKlingImageTask(input, opts);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await abortableDelay(pollMs, opts.signal);
    const task = await getKlingImageTask(taskId, opts);
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
