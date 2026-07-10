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

/** RPC over curl --http1.1: Node 26's fetch/undici gets nothing back from this
 *  server's abruptly-terminated SSE streams (NGHTTP2_INTERNAL_ERROR before any
 *  body chunk reaches the reader). curl on HTTP/1.1 receives the data event
 *  fine; the server then drops the connection, which makes curl exit nonzero
 *  (18/56) — we tolerate that and keep stdout. The Bearer token goes in a
 *  header FILE (never argv, never error messages). */
const TMP = path.join(
  process.env.TMPDIR || "/tmp",
  `hf-probe-${process.pid}`
);
let tmpReady = false;
async function rpc(method: string, params: unknown, isNotification = false): Promise<any> {
  if (!tmpReady) {
    await fs.mkdir(TMP, { recursive: true });
    tmpReady = true;
  }
  const reqId = isNotification ? undefined : Math.floor(Math.random() * 1e9);
  const body: Record<string, unknown> = { jsonrpc: "2.0", method, params };
  if (reqId !== undefined) body.id = reqId;

  const hdrFile = path.join(TMP, "h.txt");
  const bodyFile = path.join(TMP, "b.json");
  const respHdrFile = path.join(TMP, "rh.txt");
  const headerLines = [
    "Content-Type: application/json",
    "Accept: application/json, text/event-stream",
    `Authorization: Bearer ${await accessToken()}`,
  ];
  if (session) headerLines.push(`Mcp-Session-Id: ${session}`);
  await fs.writeFile(hdrFile, headerLines.join("\n") + "\n");
  await fs.writeFile(bodyFile, JSON.stringify(body));

  let stdout = "";
  try {
    const r = await execFileP("curl", [
      "--http1.1", "-s", "-N", "--max-time", "120",
      "-H", `@${hdrFile}`,
      "-D", respHdrFile,
      "--data-binary", `@${bodyFile}`,
      MCP_URL,
    ], { maxBuffer: 64 * 1024 * 1024 });
    stdout = r.stdout;
  } catch (e: any) {
    // exit 18 (partial transfer) / 56 (recv failure) after the data arrived
    stdout = e?.stdout ?? "";
    if (!stdout) throw new Error(`MCP ${method}: curl exit ${e?.code ?? "?"}, no body`);
  }

  let status = 0;
  let contentType = "";
  try {
    const rh = await fs.readFile(respHdrFile, "utf8");
    // last header block wins (redirect-free here, but be safe)
    const block = rh.trim().split(/\r?\n\r?\n/).pop() || "";
    status = Number(block.match(/^HTTP\/[\d.]+\s+(\d+)/)?.[1] || 0);
    contentType = block.match(/^content-type:\s*(.+)$/im)?.[1]?.trim() || "";
    const sid = block.match(/^mcp-session-id:\s*(.+)$/im)?.[1]?.trim();
    if (sid) session = sid;
  } catch {}

  if (isNotification) return null;
  if (status && (status < 200 || status >= 300)) {
    throw new Error(`MCP ${method} ${status}: ${stdout.slice(0, 300)}`);
  }
  const answer = parseMessages(stdout, contentType || "text/event-stream").find(
    (m) => m?.id === reqId
  );
  if (!answer) throw new Error(`MCP ${method}: no matching response — ${stdout.slice(0, 200)}`);
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

/** media_upload's presigned-URL generation consistently fails server-side for
 *  this account ("Something went wrong", e.g. Request ID d77f6ce0-…). The refs
 *  are publicly served by the prod media proxy, so import them by URL instead —
 *  media_import_url returns an already-confirmed media_id. */
const REF_URLS = [
  "https://aistudio-v1.vercel.app/api/media/references/31d0523e-a795-42f4-b25d-fa04cdb531f5-0.jpg",
  "https://aistudio-v1.vercel.app/api/media/references/31d0523e-a795-42f4-b25d-fa04cdb531f5-1.jpg",
  "https://aistudio-v1.vercel.app/api/media/references/31d0523e-a795-42f4-b25d-fa04cdb531f5-2.jpg",
];

async function importRef(url: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await callTool("media_import_url", { url, type: "image" });
      const id = res.structuredContent?.media_id;
      if (!id) throw new Error("no media_id — " + JSON.stringify(res).slice(0, 200));
      return id;
    } catch (e: any) {
      lastErr = e;
      console.log(`media_import_url attempt ${attempt} failed (${String(e?.message).slice(0, 80)}), retrying…`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
  throw lastErr;
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
  // The token file has no obtained_at, so the staleness check can't see that a
  // days-old access_token expired (the server's 401 hides behind a generic
  // "Something went wrong"). Always start from a fresh access token.
  await refreshToken();
  console.log("token refreshed");
  const mediaIds: string[] = [];
  for (const [i, url] of REF_URLS.entries()) {
    mediaIds.push(await importRef(url));
    console.log(`imported ref-${i + 1}: ${mediaIds[i]}`);
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
