/**
 * Gemini Omni Flash (gemini-omni-flash-preview) — video via Google's
 * Interactions API. Built to give video the same NBP-grade reference/prompt
 * scaffolding images already get (see ../omni-input.ts), not a hand-rolled
 * flat prompt like the Higgsfield/Seedance video paths.
 *
 * PROBE VERDICTS (re-measured 2026-07-11 against this project's
 * GOOGLE_API_KEY — a first pass this same day carried over stale
 * half-remembered facts after a client crash wiped the working notes; THESE
 * are the ones actually exercised against the live endpoint and are
 * binding). Overrides public docs and anything said elsewhere:
 * - Endpoint: POST https://generativelanguage.googleapis.com/v1beta/interactions
 *   (auth via `x-goog-api-key` HEADER, never a `?key=` query string). Poll
 *   GET .../interactions/{id} with the same header. The response id comes
 *   back as `id` (not `name`).
 * - Vertex variant: POST https://aiplatform.googleapis.com/v1beta1/projects/
 *   {project}/locations/global/interactions — OAuth2 Bearer only, API keys
 *   rejected (per docs; not independently re-verified this session — this
 *   machine's Vertex creds are dead, see OMNI_USE_VERTEX below). Public
 *   reports + a Google forum staff reply (2026-06-25) say Vertex Omni access
 *   is allowlist-gated.
 * - Body is `{model, input, background, response_format}`. There is NO
 *   `task` field — sending one 400s with "Unknown parameter 'task'". The
 *   model infers text-to-video vs. reference-to-video purely from whether
 *   `input` contains any image parts.
 * - There is also NO `delivery` field (docs/memory said "inline"|"uri" —
 *   both wrong here; sending it 400s with "Unknown parameter 'delivery'").
 *   Every real response observed came back with the video inlined as base64
 *   regardless — see the steps[] shape below.
 * - `input` is an array of items; the `type` enum is large (function_call,
 *   model_output, thought, document, …) because Interactions is a shared
 *   schema across Google's agent products — for our purposes only two item
 *   shapes matter: `{type:"text", text}` and `{type:"image", mime_type,
 *   data}` (snake_case `mime_type` — camelCase `mimeType` 400s with "Did you
 *   mean 'mime_type'?").
 * - `response_format` is optional; when provided: `{type:"video",
 *   aspect_ratio, duration}`. `type` must be `"video"` (its accepted enum
 *   also includes text/image/audio/etc — those are for other Interactions
 *   use cases). `aspect_ratio` enum is exactly `"16:9"|"9:16"` (confirmed:
 *   any other value 400s with the exact supported-values list). `duration`
 *   is a real, enforced request field — a protobuf-Duration-style STRING
 *   like `"4s"` (a bare number, or a string missing the trailing "s", both
 *   400 with "Invalid input at 'response_format'"). Resolution is NOT
 *   controllable anywhere (`response_format.resolution` and a top-level
 *   `resolution` both 400 as unknown parameters) — omit it entirely.
 * - `background:true` is accepted (not validated further here — this
 *   session's two real generations both omitted it and returned
 *   `status:"completed"` synchronously in the same HTTP response; whether
 *   `background:true` actually defers to async `in_progress` + polling is
 *   confirmed by this file's accompanying live test, not by a cheap probe,
 *   since exercising it requires a real generation).
 * - Statuses actually observed: `completed`. The rest of the status enum
 *   (`in_progress|failed|cancelled|incomplete|budget_exceeded|
 *   requires_action`) is carried over from Google's documented Interactions
 *   status set (shared across all uses of the API), not independently
 *   reproduced this session — mapOmniStatus still handles all of them, with
 *   an unknown-status fallback to "running" as the safety net either way.
 * - Video payload shape (measured on a real completed interaction):
 *   `steps[]` is an array of turn-like items, each with its own `type`
 *   (e.g. `"thought"`, `"model_output"`) — NOT nested under a
 *   `step.model_output.content` wrapper. The step whose `type` is
 *   `"model_output"` carries a `content` array; the video entry in it is
 *   `{type:"video", mime_type, data}` (base64), e.g. `video/mp4`.
 * - Live-measured cost signal: two ~4s clips totalled ~58,700 tokens each
 *   (~57,900 video output tokens each) — consistent with treating this as a
 *   flat-ish per-second product rather than needing token-level billing
 *   logic.
 */
import { GoogleAuth } from "google-auth-library";
import type { AssembledPrompt } from "../prompt-assembler";
import { buildOmniInput } from "../omni-input";

const MODEL_ID = process.env.OMNI_MODEL || "gemini-omni-flash-preview";
const OMNI_ASPECT_RATIOS = ["16:9", "9:16"] as const;

const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});

export function isOmniModel(model: string): boolean {
  return /omni/i.test(model);
}

export interface OmniAuth {
  apiKey?: string;
  bearerToken?: string;
}

/** Refuses to attach any credential to a host that isn't a Google API host —
 *  guards a video-download path against a malicious/rebound URI siphoning
 *  the API key or bearer token to an arbitrary host. (No real response has
 *  been observed to carry a downloadable uri instead of inline data — see
 *  extractOmniVideo — but this stays as defense in depth in case a future/
 *  larger-payload response does.) */
export function assertGoogleHost(url: string): void {
  const { hostname } = new URL(url);
  if (hostname !== "googleapis.com" && !hostname.endsWith(".googleapis.com")) {
    throw new Error(
      `Refusing to attach Omni credentials to unexpected host: ${hostname}`
    );
  }
}

/** Pure: create-endpoint base for the chosen wire path. Poll endpoint is this
 *  plus "/{interactionId}". */
export function buildOmniEndpoint(opts: {
  vertex: boolean;
  project?: string;
  location?: string;
}): string {
  if (opts.vertex) {
    if (!opts.project) {
      throw new Error("Vertex Omni requires a GCP project id.");
    }
    const location = opts.location || "global";
    return `https://aiplatform.googleapis.com/v1beta1/projects/${opts.project}/locations/${location}/interactions`;
  }
  return "https://generativelanguage.googleapis.com/v1beta/interactions";
}

/** Pure: the create-request body. Throws on an unsupported aspect ratio
 *  BEFORE any network call (AC3 — mirrors the Seedance Mini resolution
 *  guard's fail-fast shape). `duration` is formatted as the protobuf-
 *  Duration string the API actually requires (e.g. 4 -> "4s"). */
export function buildOmniPayload(
  input: ReturnType<typeof buildOmniInput>,
  aspectRatio: string,
  duration: number
): Record<string, unknown> {
  if (!OMNI_ASPECT_RATIOS.includes(aspectRatio as (typeof OMNI_ASPECT_RATIOS)[number])) {
    throw new Error(
      `Gemini Omni Flash only supports 16:9/9:16 aspect ratios (got "${aspectRatio}").`
    );
  }
  return {
    model: MODEL_ID,
    input,
    background: true,
    response_format: {
      type: "video",
      aspect_ratio: aspectRatio,
      duration: `${duration}s`,
    },
  };
}

/** Pure: maps every documented Interactions API status onto the app's
 *  running|succeeded|failed states (AC6) — unknown values fall back to
 *  "running" so a not-yet-seen status doesn't fail a job outright; the
 *  route's 30-minute poll timeout is the backstop against silent hangs. */
export function mapOmniStatus(raw: string | undefined): "running" | "succeeded" | "failed" {
  if (raw === "completed") return "succeeded";
  if (raw === "in_progress") return "running";
  if (
    raw === "failed" ||
    raw === "cancelled" ||
    raw === "incomplete" ||
    raw === "budget_exceeded" ||
    raw === "requires_action"
  ) {
    return "failed";
  }
  return "running";
}

/** Extracts the finished video from a completed interaction. Real responses
 *  observed so far always inline the video as base64 inside the
 *  model_output step's content array; the output_video.uri branch below is
 *  unexercised defense-in-depth (see assertGoogleHost's comment), gated
 *  before any credential is attached. */
export async function extractOmniVideo(
  json: any,
  omniAuth?: OmniAuth
): Promise<{ base64: string; mimeType: string }> {
  const steps = json?.steps ?? [];
  for (const step of steps) {
    const content = step?.content ?? [];
    for (const part of content) {
      if (part?.type === "video" && part?.data) {
        return { base64: part.data, mimeType: part.mime_type || "video/mp4" };
      }
    }
  }

  const uri = json?.output_video?.uri;
  if (uri) {
    assertGoogleHost(uri);
    const headers: Record<string, string> = {};
    if (omniAuth?.apiKey) headers["x-goog-api-key"] = omniAuth.apiKey;
    if (omniAuth?.bearerToken) headers.Authorization = `Bearer ${omniAuth.bearerToken}`;
    const res = await fetch(uri, { headers });
    if (!res.ok) {
      throw new Error(`Failed to download Omni video from uri (${res.status}).`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      base64: buf.toString("base64"),
      mimeType: res.headers.get("content-type") || "video/mp4",
    };
  }

  throw new Error("Omni completed but returned no video (no inline data or uri).");
}

export interface OmniVideoInput {
  assembled: AssembledPrompt;
  aspectRatio: string;
  duration: number;
}

async function resolveVertexAuth(): Promise<{ project: string; token: string }> {
  let projectId = process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) {
    try {
      projectId = await auth.getProjectId();
    } catch {
      /* fall through to the error below */
    }
  }
  const token = await auth.getAccessToken();
  if (!projectId || !token) {
    throw new Error(
      "OMNI_USE_VERTEX=1 auth failed. Set GOOGLE_CLOUD_PROJECT and " +
        "GOOGLE_APPLICATION_CREDENTIALS, or run `gcloud auth application-default login`."
    );
  }
  return { project: projectId, token };
}

export async function createOmniVideoTask(input: OmniVideoInput): Promise<string> {
  const vertex = process.env.OMNI_USE_VERTEX === "1";
  const parts = buildOmniInput(input.assembled);
  const payload = buildOmniPayload(parts, input.aspectRatio, input.duration);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  let endpoint: string;
  if (vertex) {
    const { project, token } = await resolveVertexAuth();
    endpoint = buildOmniEndpoint({ vertex: true, project });
    headers.Authorization = `Bearer ${token}`;
  } else {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error("GOOGLE_API_KEY is not set.");
    endpoint = buildOmniEndpoint({ vertex: false });
    headers["x-goog-api-key"] = apiKey;
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Omni create error (${res.status}): ${errText.slice(0, 400)}`);
  }
  const json = await res.json();
  const id = json?.id || json?.name;
  if (!id) throw new Error("Omni create returned no interaction id.");
  return id;
}

export interface OmniStatusResult {
  status: "running" | "succeeded" | "failed";
  videoBase64?: string;
  mimeType?: string;
  error?: string;
  moderationBlocked?: boolean;
}

export async function getOmniVideoStatus(taskId: string): Promise<OmniStatusResult> {
  const vertex = process.env.OMNI_USE_VERTEX === "1";
  const headers: Record<string, string> = {};
  let base: string;
  let omniAuth: OmniAuth;
  if (vertex) {
    const { project, token } = await resolveVertexAuth();
    base = buildOmniEndpoint({ vertex: true, project });
    headers.Authorization = `Bearer ${token}`;
    omniAuth = { bearerToken: token };
  } else {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error("GOOGLE_API_KEY is not set.");
    base = buildOmniEndpoint({ vertex: false });
    headers["x-goog-api-key"] = apiKey;
    omniAuth = { apiKey };
  }

  const res = await fetch(`${base}/${taskId}`, { headers });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Omni status error (${res.status}): ${errText.slice(0, 400)}`);
  }
  const json = await res.json();
  const status = mapOmniStatus(json?.status);

  if (status === "succeeded") {
    const { base64, mimeType } = await extractOmniVideo(json, omniAuth);
    return { status, videoBase64: base64, mimeType };
  }
  if (status === "failed") {
    const message: string =
      json?.error?.message || `Omni generation ended with status "${json?.status}".`;
    return {
      status,
      error: message,
      moderationBlocked: /polic|safety|moderat|block/i.test(message),
    };
  }
  return { status };
}
