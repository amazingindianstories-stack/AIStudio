/**
 * Council recon probe #2 (READ-ONLY):
 *  - models_explore get nano_banana_pro (+ soul_2 for contrast) → full param catalog
 *  - show_generations (image history) → stored params of past NBP jobs
 *  - job_status raw_data:true on past NBP jobs → raw FNF payload (final prompt?)
 * Never calls generate_* / upscale_* / anything that submits a job.
 * Run: npx tsx .council/higgsfield-nbp-parity/probe-mcp-catalog.ts
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const MCP_URL = "https://mcp.higgsfield.ai/mcp";
const TOKEN_URL = "https://mcp.higgsfield.ai/oauth2/token";
const TOKEN_FILE = path.join(process.cwd(), ".higgsfield-mcp-token.json");
const OUT_DIR = path.join(process.cwd(), ".council/higgsfield-nbp-parity");

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

function parseJsonRpcMessages(text: string, contentType: string): any[] {
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

class AuthError extends Error {}

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
  const text = await res.text();
  if (res.status === 401) throw new AuthError(text);
  if (!res.ok) throw new Error(`MCP ${method} ${res.status}: ${text.slice(0, 300)}`);
  const messages = parseJsonRpcMessages(text, res.headers.get("content-type") || "");
  const answer = messages.find((m) => m?.id === reqId);
  if (!answer) throw new Error(`MCP ${method}: no matching response`);
  return answer;
}

async function ensureSession(): Promise<void> {
  if (session) return;
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "lumina-council-probe", version: "0.1" },
  });
  await rpc("notifications/initialized", {}, true);
}

// READ-ONLY guard: only these tools may be called from this script.
const READ_ONLY_TOOLS = new Set(["models_explore", "show_generations", "job_status"]);

async function callTool(name: string, args: unknown): Promise<any> {
  if (!READ_ONLY_TOOLS.has(name)) throw new Error(`BLOCKED non-read-only tool: ${name}`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await ensureSession();
      const r = await rpc("tools/call", { name, arguments: args });
      if (r.error) throw new Error(`${name}: ${JSON.stringify(r.error).slice(0, 300)}`);
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

async function main() {
  // 1. Model catalog entries.
  for (const id of ["nano_banana_pro", "soul_2"]) {
    const r = await callTool("models_explore", { action: "get", model_id: id });
    await fs.writeFile(
      path.join(OUT_DIR, `mcp-model-${id}.json`),
      JSON.stringify(r, null, 2)
    );
    console.log(`models_explore get ${id}: wrote mcp-model-${id}.json`);
  }

  // 2. Image generation history (params as stored server-side).
  const hist = await callTool("show_generations", { type: "image", size: 50 });
  await fs.writeFile(
    path.join(OUT_DIR, "mcp-history-image.json"),
    JSON.stringify(hist, null, 2)
  );
  const gens: any[] =
    hist?.structuredContent?.generations ?? hist?.structuredContent?.results ?? [];
  console.log(`show_generations: ${gens.length} image generations`);
  const nbp = gens.filter((g) => /nano/i.test(g.model || ""));
  console.log(`  of which NBP: ${nbp.length}`);
  for (const g of nbp.slice(0, 6)) {
    console.log("  NBP job", g.id, "status", g.status);
  }

  // 3. Raw FNF payload for up to 3 past NBP jobs (read-only status check).
  for (const g of nbp.slice(0, 3)) {
    try {
      const raw = await callTool("job_status", { jobId: g.id, sync: false, raw_data: true });
      await fs.writeFile(
        path.join(OUT_DIR, `mcp-rawjob-${g.id}.json`),
        JSON.stringify(raw, null, 2)
      );
      console.log(`job_status raw_data for ${g.id}: wrote mcp-rawjob-${g.id}.json`);
    } catch (e: any) {
      console.log(`job_status raw for ${g.id} failed:`, e.message?.slice(0, 200));
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
