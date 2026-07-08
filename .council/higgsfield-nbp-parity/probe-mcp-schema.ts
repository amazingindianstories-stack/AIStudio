/**
 * Council recon probe: dump the FULL tool schemas of the Higgsfield MCP.
 * READ-ONLY — calls initialize + tools/list only. Never calls generate_*.
 * Run: npx tsx .council/higgsfield-nbp-parity/probe-mcp-schema.ts
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
  if (!j.access_token) throw new Error("token refresh failed: " + JSON.stringify(j).slice(0, 300));
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
  if (!answer) throw new Error(`MCP ${method}: no matching response — ${text.slice(0, 200)}`);
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

async function withAuthRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await ensureSession();
      return await fn();
    } catch (e) {
      if (e instanceof AuthError && attempt === 0) {
        await refreshToken();
        continue;
      }
      throw e;
    }
  }
  throw new Error("unreachable");
}

async function main() {
  // 1. Full tools/list (paginated if the server uses cursors).
  const tools: any[] = [];
  let cursor: string | undefined;
  do {
    const r = await withAuthRetry(() =>
      rpc("tools/list", cursor ? { cursor } : {})
    );
    if (r.error) throw new Error("tools/list error: " + JSON.stringify(r.error));
    tools.push(...(r.result?.tools ?? []));
    cursor = r.result?.nextCursor;
  } while (cursor);

  console.log(`Fetched ${tools.length} tools:`);
  for (const t of tools) console.log(" -", t.name);

  await fs.writeFile(
    path.join(OUT_DIR, "mcp-tools-full.json"),
    JSON.stringify(tools, null, 2)
  );
  console.log("\nWrote full dump to mcp-tools-full.json");

  // 2. Also list prompts/resources if the server exposes them (read-only).
  for (const method of ["prompts/list", "resources/list"]) {
    try {
      const r = await withAuthRetry(() => rpc(method, {}));
      const payload = r.error ?? r.result;
      await fs.writeFile(
        path.join(OUT_DIR, `mcp-${method.replace("/", "-")}.json`),
        JSON.stringify(payload, null, 2)
      );
      console.log(`${method}:`, JSON.stringify(payload).slice(0, 300));
    } catch (e: any) {
      console.log(`${method} failed:`, e.message?.slice(0, 200));
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
