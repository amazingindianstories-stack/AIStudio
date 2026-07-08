/**
 * Council control probe v2 (user-approved, 2 paid generations ≈28¢).
 * Self-contained MCP client (same rpc shape as probe-mcp-schema.ts). The
 * presigned CDN PUT goes through `curl --http1.1` — Node 26's fetch dies with
 * NGHTTP2_INTERNAL_ERROR on that endpoint (the provider code is fine on
 * Vercel's Node 24; this is a local-probe workaround, not an app bug).
 * Run: npx tsx .council/higgsfield-nbp-parity/probe-hf-control2.ts
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const MCP_URL = "https://mcp.higgsfield.ai/mcp";
const TOKEN_URL = "https://mcp.higgsfield.ai/oauth2/token";
const TOKEN_FILE = path.join(process.cwd(), ".higgsfield-mcp-token.json");
const DIR = path.join(process.cwd(), ".council/higgsfield-nbp-parity");

const PROMPT =
  "THIS EXACT FACE and identity from @img1(image_1). She stands near a DJ booth in the corner of the nightclub from @img3(image_3), Speaker stacks behind her. She wears the exact outfit from @img2(image_2). Black onyx drop earrings and a delicate black choker. Red haze, silhouettes of dancers around her. Cinematic nightlife photography. @img1";

interface TokenData {
  access_token: string;
  refresh_token: string;
  client_id: string;
  expires_in?: number;
  obtained_at?: number;
}
let token: TokenData | null = null;
let session: string | null = null;

async function loadToken(): Promise<TokenData> {
  if (token) return token;
  const raw = JSON.parse(await fs.readFile(TOKEN_FILE, "utf8"));
  token = { ...raw, obtained_at: raw.obtained_at ?? Date.now() };
  return token!;
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
  if (!j.access_token) throw new Error("token refresh failed");
  token = {
    access_token: j.access_token,
    refresh_token: j.refresh_token || t.refresh_token,
    client_id: t.client_id,
    expires_in: j.expires_in,
    obtained_at: Date.now(),
  };
  await fs.writeFile(TOKEN_FILE, JSON.stringify(token, null, 2));
  session = null;
}

async function accessToken(): Promise<string> {
  const t = await loadToken();
  const stale =
    !t.access_token ||
    (t.obtained_at && t.expires_in
      ? Date.now() > t.obtained_at + (t.expires_in - 300) * 1000
      : !t.access_token);
  if (stale) await refreshToken();
  return token!.access_token;
}

function parseMessages(text: string, contentType: string): any[] {
  if (!contentType.includes("text/event-stream")) {
    try {
      return [JSON.parse(text)];
    } catch {
      return [];
    }
  }
  const out: any[] = [];
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
    } catch {}
  }
  return out;
}

/** Read a response body tolerating abrupt stream termination: the MCP's SSE
 *  responses for some tools (media_upload, generate_*) abort the stream after
 *  the data event, which makes res.text() throw "terminated" even though the
 *  full JSON-RPC answer already arrived. Accumulate what we got. */
async function bodyText(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
  } catch {
    /* abrupt termination — keep what arrived */
  }
  return out;
}

async function rpc(method: string, params: unknown, isNotification = false): Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${await accessToken()}`,
  };
  if (session) headers["Mcp-Session-Id"] = session;
  const reqId = isNotification ? undefined : Math.floor(Math.random() * 1e9);
  const body: Record<string, unknown> = { jsonrpc: "2.0", method, params };
  if (reqId !== undefined) body.id = reqId;
  const res = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(body) });
  const sid = res.headers.get("mcp-session-id");
  if (sid) session = sid;
  if (isNotification) return null;
  const text = await bodyText(res);
  if (!res.ok) throw new Error(`MCP ${method} ${res.status}: ${text.slice(0, 300)}`);
  const answer = parseMessages(text, res.headers.get("content-type") || "").find(
    (m) => m?.id === reqId
  );
  if (!answer) throw new Error(`MCP ${method}: no matching response — ${text.slice(0, 200)}`);
  if (answer.error) throw new Error(`MCP ${method}: ${JSON.stringify(answer.error).slice(0, 300)}`);
  return answer.result;
}

async function ensureSession(): Promise<void> {
  if (session) return;
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "lumina-council-control", version: "0.1" },
  });
  await rpc("notifications/initialized", {}, true);
}

async function callTool(name: string, args: unknown): Promise<any> {
  await ensureSession();
  const r = await rpc("tools/call", { name, arguments: args });
  if (r?.isError) {
    const txt = (r?.content || []).map((c: any) => c?.text || "").join(" ");
    throw new Error(`${name}: ${txt.slice(0, 300) || "tool error"}`);
  }
  return r;
}

async function uploadRef(file: string): Promise<string> {
  const res = await callTool("media_upload", {
    method: "upload_url",
    filename: path.basename(file),
    content_type: "image/jpeg",
  });
  const item = res.structuredContent?.uploads?.[0];
  if (!item?.upload_url || !item?.media_id) throw new Error("no presigned url");
  // Node 26 fetch hits NGHTTP2_INTERNAL_ERROR on this PUT; curl is reliable.
  const { stdout } = await execFileP("curl", [
    "--http1.1",
    "-s",
    "-o",
    "/dev/null",
    "-w",
    "%{http_code}",
    "-X",
    "PUT",
    "-H",
    "Content-Type: image/jpeg",
    "--data-binary",
    `@${file}`,
    item.upload_url,
  ]);
  if (stdout.trim() !== "200") throw new Error(`CDN PUT failed: HTTP ${stdout}`);
  await callTool("media_confirm", { type: "image", media_id: item.media_id });
  return item.media_id;
}

function jobIdFrom(res: any): string | undefined {
  const fromStruct = res?.structuredContent?.results?.[0]?.id;
  if (fromStruct) return fromStruct;
  const text = (res?.content || []).map((c: any) => c?.text || "").join("\n");
  return text.match(
    /^-\s*([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/m
  )?.[1];
}

async function generate(mediaIds: string[]): Promise<string> {
  const params: Record<string, unknown> = {
    model: "nano_banana_pro",
    prompt: PROMPT.replace(/@img(\d+)/gi, (_, n) => `<<<image_${n}>>>`),
    aspect_ratio: "21:9",
    resolution: "2k",
    medias: mediaIds.map((id) => ({ value: id, role: "image" })),
  };
  let res = await callTool("generate_image", { params });
  const text = (res?.content || []).map((c: any) => c?.text || "").join("\n");
  const preset = text.match(/Preset id:\s*([0-9a-f-]{36})/i)?.[1];
  if (preset && !res?.structuredContent?.results?.length) {
    console.log("declining preset", preset);
    res = await callTool("generate_image", {
      params: { ...params, declined_preset_id: preset },
    });
  }
  const id = jobIdFrom(res);
  if (!id) throw new Error("no job id — " + JSON.stringify(res).slice(0, 300));
  return id;
}

async function awaitJob(jobId: string): Promise<string> {
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const res = await callTool("job_status", { jobId, sync: false });
    const g = res.structuredContent?.generation || {};
    if (g.status === "completed") return g.results?.rawUrl || g.results?.minUrl;
    if (["failed", "canceled", "nsfw", "ip_detected", "ip_detect"].includes(g.status)) {
      throw new Error(`job ${jobId}: ${g.status}`);
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  throw new Error("timeout");
}

async function main() {
  const sharp = (await import("sharp")).default;
  const mediaIds: string[] = [];
  for (let i = 1; i <= 3; i++) {
    mediaIds.push(await uploadRef(path.join(DIR, `ref-${i}.jpg`)));
    console.log(`uploaded ref-${i}`);
  }
  const jobs = [await generate(mediaIds), await generate(mediaIds)];
  console.log("jobs:", jobs.join(", "));
  for (const [i, id] of jobs.entries()) {
    const url = await awaitJob(id);
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    const f = path.join(DIR, `hf-control-${i + 1}.png`);
    await fs.writeFile(f, buf);
    const m = await sharp(buf).metadata();
    console.log(`hf-control-${i + 1}.png ${m.width}x${m.height}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
