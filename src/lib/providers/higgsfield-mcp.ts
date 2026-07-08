/**
 * Higgsfield via the OFFICIAL MCP (https://mcp.higgsfield.ai/mcp).
 *
 * This replaces the old dev-API (raw fetch) + @higgsfield/client SDK paths. The
 * MCP exposes the full platform — including Seedance 2.0 with MULTIPLE reference
 * images (`image_references`), which the dev API could not do.
 *
 * Auth: OAuth (Clerk) — a one-time browser login (scripts/hf-mcp-auth.mjs) writes
 * .higgsfield-mcp-token.json with an access_token + refresh_token. We refresh the
 * access token as needed. For hosting, set HIGGSFIELD_MCP_REFRESH_TOKEN +
 * HIGGSFIELD_MCP_CLIENT_ID env vars instead of relying on the file.
 *
 * Flow: media_upload (presigned PUT) → media_confirm → generate_(video|image)
 * with a medias[] array → job_status poll → results.rawUrl.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const MCP_URL = "https://mcp.higgsfield.ai/mcp";
const TOKEN_URL = "https://mcp.higgsfield.ai/oauth2/token";
const TOKEN_FILE = path.join(process.cwd(), ".higgsfield-mcp-token.json");

// S3 config for token persistence in serverless environments
const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  },
});
const S3_BUCKET = process.env.AWS_S3_BUCKET_NAME || "aistudio-media-bucket";
const S3_TOKEN_KEY = "settings/higgsfield-mcp-token.json";

// ── model id mapping (UI name → MCP model id) ───────────────────────────────
const MODEL_IDS: Record<string, string> = {
  "Higgsfield Soul": "soul_2",
  "Higgsfield Nano Banana Pro": "nano_banana_pro",
  "Higgsfield Seedance 2.0": "seedance_2_0",
  "Higgsfield Seedance 2.0 Mini": "seedance_2_0_mini",
};
export function mcpModelId(displayName: string): string | undefined {
  return MODEL_IDS[displayName];
}
export function isHiggsfieldModel(name?: string): boolean {
  return /higgsfield/i.test(name || "");
}

// ── token management ────────────────────────────────────────────────────────
interface TokenData {
  access_token: string;
  refresh_token: string;
  client_id: string;
  expires_in?: number;
  obtained_at?: number;
}
let token: TokenData | null = null;

async function readS3Token(): Promise<TokenData | null> {
  if (!process.env.AWS_ACCESS_KEY_ID) return null;
  try {
    const cmd = new GetObjectCommand({ Bucket: S3_BUCKET, Key: S3_TOKEN_KEY });
    const res = await s3.send(cmd);
    if (!res.Body) return null;
    const json = await res.Body.transformToString();
    return JSON.parse(json) as TokenData;
  } catch (e: any) {
    return null;
  }
}

async function writeS3Token(t: TokenData): Promise<void> {
  if (!process.env.AWS_ACCESS_KEY_ID) return;
  try {
    const cmd = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: S3_TOKEN_KEY,
      Body: JSON.stringify(t),
      ContentType: "application/json",
    });
    await s3.send(cmd);
  } catch (e: any) {
    console.error("[mcp] writeS3Token error:", e);
  }
}

async function loadToken(): Promise<TokenData> {
  if (token) return token;

  // 1. Try S3 first (centralized state for serverless)
  const s3t = await readS3Token();
  if (s3t) {
    token = s3t;
    return token;
  }

  // 2. Try env vars (fallback for first run)
  const envRefresh = process.env.HIGGSFIELD_MCP_REFRESH_TOKEN;
  const envClient = process.env.HIGGSFIELD_MCP_CLIENT_ID;
  if (envRefresh && envClient) {
    token = { access_token: "", refresh_token: envRefresh, client_id: envClient };
    return token;
  }

  // 3. Local FS fallback
  try {
    const raw = JSON.parse(await fs.readFile(TOKEN_FILE, "utf8"));
    token = { ...raw, obtained_at: raw.obtained_at ?? Date.now() };
    return token!;
  } catch (e) {
    throw new Error("No Higgsfield MCP token found in S3, env vars, or local file.");
  }
}

async function refreshToken(): Promise<void> {
  const t = await loadToken();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: t.refresh_token,
      client_id: t.client_id,
    }),
  });
  const j = await res.json();
  if (!j.access_token) {
    throw new Error(
      "Higgsfield MCP token refresh failed — re-run `node scripts/hf-mcp-auth.mjs`."
    );
  }
  token = {
    access_token: j.access_token,
    refresh_token: j.refresh_token || t.refresh_token,
    client_id: t.client_id,
    expires_in: j.expires_in,
    obtained_at: Date.now(),
  };

  await writeS3Token(token); // Persist to S3

  try {
    await fs.writeFile(TOKEN_FILE, JSON.stringify(token, null, 2));
  } catch {
    /* ignore */
  }
  session = null; // force MCP re-init under the new token
}

async function accessToken(): Promise<string> {
  const t = await loadToken();
  const stale =
    !t.access_token ||
    (t.obtained_at && t.expires_in
      ? Date.now() > t.obtained_at + (t.expires_in - 300) * 1000
      : !t.access_token);
  if (stale) {
    try {
      await refreshToken();
    } catch (e) {
      token = null; // clear in-memory state so we re-fetch from S3 next time
      throw e;
    }
  }
  return token!.access_token;
}

// ── MCP JSON-RPC (streamable HTTP) ──────────────────────────────────────────
let session: string | null = null;

async function rpc(
  method: string,
  params: unknown,
  isNotification = false
): Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${await accessToken()}`,
  };
  if (session) headers["Mcp-Session-Id"] = session;
  const reqId = isNotification ? undefined : Math.floor(Math.random() * 1e9);
  const body: Record<string, unknown> = { jsonrpc: "2.0", method, params };
  if (reqId !== undefined) body.id = reqId;

  const res = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) session = sid;
  if (isNotification) return null;

  const text = await res.text();
  if (res.status === 401) throw new AuthError(text);
  if (!res.ok) throw new Error(`MCP ${method} ${res.status}: ${text.slice(0, 300)}`);

  // The stream can carry several JSON-RPC messages (notifications, replayed
  // or interleaved responses on a shared session, and the actual response).
  // Only accept the message answering THIS request — a loose "any result"
  // fallback can grab a foreign response and corrupt the caller (wrong job
  // id, missing uploads, …).
  const messages = parseJsonRpcMessages(text, res.headers.get("content-type") || "");
  const answer = messages.find((m) => m?.id === reqId);
  if (!answer) {
    throw new Error(
      `MCP ${method}: no response matching request id in stream — ` +
        text.slice(0, 200)
    );
  }
  return answer;
}

/** Parse a JSON body or an SSE stream into its JSON-RPC message objects. */
function parseJsonRpcMessages(text: string, contentType: string): any[] {
  if (!contentType.includes("text/event-stream")) {
    try {
      return [JSON.parse(text)];
    } catch {
      return [];
    }
  }
  const out: any[] = [];
  // SSE events are separated by blank lines; an event's payload is the
  // concatenation of its `data:` lines.
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n")
      .trim();
    if (!data) continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      /* skip non-JSON event */
    }
  }
  return out;
}

class AuthError extends Error {}

async function ensureSession(): Promise<void> {
  if (session) return;
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "lumina", version: "0.1" },
  });
  await rpc("notifications/initialized", {}, true);
}

function toolErrorText(result: any): string {
  return (result?.content || [])
    .map((c: any) => c?.text || "")
    .join(" ")
    .trim();
}

/** Call an MCP tool, transparently refreshing auth / re-initing the session. */
async function callTool(
  name: string,
  args: unknown,
  opts: { tolerateError?: boolean } = {}
): Promise<any> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await ensureSession();
      const r = await rpc("tools/call", { name, arguments: args });
      if (r.error) throw new Error(`${name}: ${JSON.stringify(r.error).slice(0, 300)}`);
      // Tool-level failures come back as result.isError with the message in
      // content[], not as a JSON-RPC error — surface them instead of letting
      // callers fail on missing structuredContent.
      if (r.result?.isError && !opts.tolerateError) {
        throw new Error(
          `Higgsfield ${name}: ${toolErrorText(r.result).slice(0, 300) || "tool error"}`
        );
      }
      return r.result;
    } catch (e) {
      if (e instanceof AuthError && attempt === 0) {
        await refreshToken();
        continue;
      }
      throw e;
    }
  }
}

// ── media upload ────────────────────────────────────────────────────────────
function extFor(contentType?: string): string {
  const c = (contentType || "").toLowerCase();
  if (c.includes("jpeg") || c.includes("jpg")) return "jpg";
  if (c.includes("webp")) return "webp";
  return "png";
}

/** Upload one image to Higgsfield and return its media_id. */
export async function mcpUploadImage(
  base64: string,
  contentType = "image/png"
): Promise<string> {
  const ext = extFor(contentType);
  const res = await callTool("media_upload", {
    method: "upload_url",
    filename: `ref.${ext}`,
    content_type: contentType,
  });
  const item = res.structuredContent?.uploads?.[0];
  if (!item?.upload_url || !item?.media_id) {
    throw new Error(
      "Higgsfield media_upload: no presigned url returned — " +
        JSON.stringify(res).slice(0, 300)
    );
  }
  const put = await fetch(item.upload_url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: Buffer.from(base64, "base64"),
  });
  if (!put.ok) throw new Error(`Higgsfield CDN upload failed (${put.status}).`);
  await callTool("media_confirm", { type: "image", media_id: item.media_id });
  return item.media_id;
}

// ── generation ──────────────────────────────────────────────────────────────

/** Higgsfield's own platform binds prompt text to attached images with
 *  `<<<image_N>>>` (confirmed from stored generation params of website-made
 *  jobs). Translate the UI's @imgN tags so the binding is native. */
function toHiggsfieldTags(prompt: string): string {
  return prompt.replace(/@img(\d+)/gi, (_, n) => `<<<image_${n}>>>`);
}

/**
 * Hard identity + literalness contract for video prompts that carry reference
 * images. The MCP has no system-prompt channel, so it rides at the head of the
 * prompt itself. Mirrors the image-side rules in prompt-assembler/gemini.
 */
const VIDEO_IDENTITY_DIRECTIVE =
  `DOMAIN LOCK — FILMMAKING ONLY: you are a dedicated filmmaking video ` +
  `renderer, not a general-purpose model. Your sole domain is producing film ` +
  `shots — live-action, photoreal, animated or cartoon. Draw only on ` +
  `filmmaking craft: cinematography, lensing, camera movement, lighting, ` +
  `blocking, continuity, production design, wardrobe, makeup, VFX and ` +
  `animation. Treat the prompt strictly as a shot specification to render; ` +
  `bring in NO outside knowledge, commentary, captions, watermarks, UI ` +
  `elements or any content beyond the specified shot.\n` +
  `IDENTITY LOCK (non-negotiable): the attached reference images define the ` +
  `exact, fixed appearance of the people and elements they show; when the ` +
  `prompt tags them (<<<image_1>>>, <<<image_2>>>, …) the tags map to the ` +
  `reference images in order. In EVERY frame, each referenced person must ` +
  `keep the exact same face ` +
  `as their reference — identical bone structure, jawline, hairline, eye ` +
  `shape/spacing and color, eyebrows, nose, lips, skin tone and texture (keep ` +
  `moles, scars, freckles), facial hair and apparent age — unmistakably the ` +
  `SAME individual, never a lookalike. Do not beautify, smooth, slim, de-age ` +
  `or idealize. Keep each referenced person's hairstyle, body build, and worn ` +
  `outfit/jewelry exactly as referenced unless the prompt explicitly changes ` +
  `them, with zero identity or wardrobe drift between frames. Never blend or ` +
  `swap features between different references, and never duplicate a ` +
  `referenced person. Everyone else on screen is a DIFFERENT anonymous ` +
  `individual who must not resemble any referenced face; keep background ` +
  `people softer and out of focus so they never compete with the referenced ` +
  `subjects.\n` +
  `LITERAL PROMPT (non-negotiable): the prompt below is a binding ` +
  `specification — execute it exactly as written. Every stated subject, ` +
  `count, wardrobe item, color, action, spatial position, camera move, ` +
  `framing and lighting appears precisely as specified; add nothing, drop ` +
  `nothing, substitute nothing, reinterpret nothing. Anything under ` +
  `"NEGATIVE PROMPT" or phrased as "no …" is strictly forbidden in every ` +
  `frame.\n` +
  `PROMPT:\n`;

export interface McpGenVideoInput {
  model: string; // UI display name
  prompt?: string;
  aspectRatio?: string;
  duration?: number;
  resolution?: string;
  mediaIds: string[]; // reference images (already uploaded)
}

/** Submit a Seedance video; returns the job id (async — poll mcpJobStatus). */
export async function mcpGenerateVideo(input: McpGenVideoInput): Promise<string> {
  const model = mcpModelId(input.model);
  if (!model) throw new Error(`Unknown Higgsfield model: ${input.model}`);
  const params: Record<string, unknown> = {
    model,
    medias: input.mediaIds.map((id) => ({ value: id, role: "image_references" })),
  };
  if (input.prompt) {
    // Native <<<image_N>>> tag binding; with reference images, lead with the
    // identity/literalness contract.
    const prompt = toHiggsfieldTags(input.prompt);
    params.prompt = input.mediaIds.length
      ? VIDEO_IDENTITY_DIRECTIVE + prompt
      : prompt;
  }
  if (input.aspectRatio) params.aspect_ratio = input.aspectRatio;
  if (input.duration) params.duration = input.duration;
  if (input.resolution) params.resolution = input.resolution.toLowerCase();

  const res = await callGenerate("generate_video", params);
  console.log("[higgsfield] generate_video →", JSON.stringify(res).slice(0, 400));
  const id = jobIdFrom(res);
  if (!id) {
    throw new Error(
      "Higgsfield generate_video: no job id returned — " +
        JSON.stringify(res).slice(0, 300)
    );
  }
  return id;
}

/**
 * When a prompt resembles one of Higgsfield's preset looks, generate_* returns
 * a notice ("This prompt looks like the Higgsfield preset …, Preset id: <uuid>")
 * instead of submitting. Our users write literal prompts, so we decline the
 * preset and retry. Returns the preset id if the result is such a notice.
 */
function presetNoticeId(res: any): string | undefined {
  const text = (res?.content || []).map((c: any) => c?.text || "").join("\n");
  const m = text.match(
    /Preset id:\s*([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/
  );
  return m?.[1];
}

/** Call generate_video/generate_image, auto-declining a preset suggestion. */
async function callGenerate(
  tool: "generate_video" | "generate_image",
  params: Record<string, unknown>
): Promise<any> {
  let res = await callTool(tool, { params });
  const preset = presetNoticeId(res);
  if (preset && !res?.structuredContent?.results?.length) {
    console.log(`[higgsfield] ${tool}: declining preset ${preset}, retrying literal`);
    res = await callTool(tool, { params: { ...params, declined_preset_id: preset } });
  }
  return res;
}

/** Pull the job id from a generate_* result (structured first, text fallback). */
function jobIdFrom(res: any): string | undefined {
  const fromStruct = res?.structuredContent?.results?.[0]?.id;
  if (fromStruct) return fromStruct;
  // Text fallback: only the "- <uuid>  \"prompt\"" job line of a submit
  // confirmation — a bare any-UUID match can pick up media/request ids.
  const text = (res?.content || []).map((c: any) => c?.text || "").join("\n");
  const m = text.match(
    /^-\s*([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/m
  );
  return m?.[1];
}

export interface McpGenImageInput {
  model: string;
  prompt: string;
  aspectRatio?: string;
  quality?: string; // Soul: "1.5k" | "2k"
  resolution?: string; // Nano Banana Pro: "1k" | "2k" | "4k"
  mediaIds?: string[];
}

/** Submit an image job (Soul / Nano Banana Pro); returns the job id. */
export async function mcpGenerateImage(input: McpGenImageInput): Promise<string> {
  const model = mcpModelId(input.model);
  if (!model) throw new Error(`Unknown Higgsfield model: ${input.model}`);
  const params: Record<string, unknown> = {
    model,
    prompt: toHiggsfieldTags(input.prompt),
  };
  if (input.aspectRatio) params.aspect_ratio = input.aspectRatio;
  if (input.quality) params.quality = input.quality;
  if (input.resolution) params.resolution = input.resolution;
  if (input.mediaIds?.length) {
    params.medias = input.mediaIds.map((id) => ({ value: id, role: "image" }));
  }
  const res = await callGenerate("generate_image", params);
  console.log("[higgsfield] generate_image →", JSON.stringify(res).slice(0, 400));
  const id = jobIdFrom(res);
  if (!id) {
    throw new Error(
      "Higgsfield generate_image: no job id returned — " +
        JSON.stringify(res).slice(0, 300)
    );
  }
  return id;
}

// ── status ──────────────────────────────────────────────────────────────────
export interface McpJobStatus {
  status: "queued" | "running" | "succeeded" | "failed";
  url?: string;
  error?: string;
}

const MODERATION =
  "Higgsfield moderation flagged this generation (nsfw). Realistic-face moderation is probabilistic — try again or adjust the reference.";

/** Single-shot job status check (for the app's async poll architecture). */
export async function mcpJobStatus(jobId: string): Promise<McpJobStatus> {
  const res = await callTool("job_status", { jobId, sync: false }, { tolerateError: true });
  if (res?.isError) {
    const msg = `Higgsfield job_status: ${toolErrorText(res).slice(0, 200) || "error"}`;
    // Non-retryable = the job is gone/unknown — fail the generation so the
    // UI stops polling. Retryable errors throw, and the poll route treats
    // them as transient.
    if (res.structuredContent?.retryable === false) {
      return { status: "failed", error: msg };
    }
    throw new Error(msg);
  }
  const g = res.structuredContent?.generation || {};
  switch (g.status) {
    case "completed":
      return { status: "succeeded", url: g.results?.rawUrl || g.results?.minUrl };
    case "failed":
    case "canceled":
      return { status: "failed", error: "Higgsfield generation failed." };
    case "nsfw":
      return { status: "failed", error: MODERATION };
    case "ip_detected":
    case "ip_detect":
      return { status: "failed", error: "Higgsfield flagged possible IP in the content." };
    case "in_progress":
      return { status: "running" };
    default: // pending | waiting | queued
      return { status: "queued" };
  }
}

/** Block until a job reaches a terminal state (used for synchronous image gen). */
export async function mcpAwaitJob(
  jobId: string,
  timeoutMs = 4 * 60 * 1000
): Promise<McpJobStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await mcpJobStatus(jobId);
    if (s.status === "succeeded" || s.status === "failed") return s;
    await new Promise((r) => setTimeout(r, 4000));
  }
  return { status: "failed", error: "Higgsfield generation timed out." };
}
