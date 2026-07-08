/**
 * Council recon probe #5 (READ-ONLY): models_explore get for image models of
 * interest. Run: npx tsx .council/higgsfield-nbp-parity/probe-mcp-models.ts
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const MCP_URL = "https://mcp.higgsfield.ai/mcp";
const TOKEN_URL = "https://mcp.higgsfield.ai/oauth2/token";
const TOKEN_FILE = path.join(process.cwd(), ".higgsfield-mcp-token.json");
const OUT_DIR = path.join(process.cwd(), ".council/higgsfield-nbp-parity");

let token: any = null;
let session: string | null = null;
async function loadToken() {
  if (token) return token;
  token = JSON.parse(await fs.readFile(TOKEN_FILE, "utf8"));
  token.obtained_at = token.obtained_at ?? Date.now();
  return token;
}
async function refreshToken() {
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
async function accessToken() {
  const t = await loadToken();
  const stale =
    !t.access_token ||
    (t.obtained_at && t.expires_in
      ? Date.now() > t.obtained_at + (t.expires_in - 300) * 1000
      : !t.access_token);
  if (stale) await refreshToken();
  return token.access_token;
}
function parseMsgs(text: string, ct: string): any[] {
  if (!ct.includes("text/event-stream")) {
    try {
      return [JSON.parse(text)];
    } catch {
      return [];
    }
  }
  const out: any[] = [];
  for (const ev of text.split(/\r?\n\r?\n/)) {
    const data = ev
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
async function rpc(method: string, params: unknown, notif = false): Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${await accessToken()}`,
  };
  if (session) headers["Mcp-Session-Id"] = session;
  const id = notif ? undefined : Math.floor(Math.random() * 1e9);
  const body: any = { jsonrpc: "2.0", method, params };
  if (id !== undefined) body.id = id;
  const res = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(body) });
  const sid = res.headers.get("mcp-session-id");
  if (sid) session = sid;
  if (notif) return null;
  const text = await res.text();
  if (res.status === 401) throw new AuthError(text);
  if (!res.ok) throw new Error(`MCP ${method} ${res.status}: ${text.slice(0, 300)}`);
  const a = parseMsgs(text, res.headers.get("content-type") || "").find((m) => m?.id === id);
  if (!a) throw new Error(`MCP ${method}: no matching response`);
  return a;
}
async function ensureSession() {
  if (session) return;
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "lumina-council-probe", version: "0.1" },
  });
  await rpc("notifications/initialized", {}, true);
}
async function callTool(name: string, args: unknown) {
  if (name !== "models_explore") throw new Error("BLOCKED: " + name);
  for (let i = 0; i < 2; i++) {
    try {
      await ensureSession();
      const r = await rpc("tools/call", { name, arguments: args });
      if (r.error) throw new Error(JSON.stringify(r.error).slice(0, 300));
      return r.result;
    } catch (e) {
      if (e instanceof AuthError && i === 0) {
        await refreshToken();
        continue;
      }
      throw e;
    }
  }
}
async function main() {
  const ids = [
    "nano_banana_2",
    "nano_banana_2_shots",
    "topaz_image",
    "topaz_image_generative",
    "soul_cinematic",
    "cinematic_studio_2_5",
    "image_auto",
  ];
  for (const id of ids) {
    try {
      const r = await callTool("models_explore", { action: "get", model_id: id });
      const sc = r.structuredContent ?? r;
      await fs.writeFile(path.join(OUT_DIR, `mcp-model-${id}.json`), JSON.stringify(sc, null, 2));
      console.log("WROTE", id);
    } catch (e: any) {
      console.log(id, "FAILED:", e.message?.slice(0, 200));
    }
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
