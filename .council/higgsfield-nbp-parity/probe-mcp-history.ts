/**
 * Council recon probe #3 (READ-ONLY): paginate image history to find the
 * nightclub comparison job, dump full stored params, and fetch raw job data.
 * Run: npx tsx .council/higgsfield-nbp-parity/probe-mcp-history.ts
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
const READ_ONLY_TOOLS = new Set(["show_generations", "job_status"]);
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
  const all: any[] = [];
  let cursor: number | undefined;
  for (let page = 0; page < 8; page++) {
    const args: any = { type: "image", size: 100 };
    if (cursor != null) args.cursor = cursor;
    const r = await callTool("show_generations", args);
    const sc = r?.structuredContent || {};
    const items: any[] = sc.items ?? [];
    all.push(...items);
    console.log(`page ${page}: ${items.length} items, next_cursor=${sc.next_cursor}`);
    if (sc.next_cursor == null || items.length === 0) break;
    cursor = sc.next_cursor;
  }
  await fs.writeFile(path.join(OUT_DIR, "mcp-history-all.json"), JSON.stringify(all, null, 2));
  console.log("total:", all.length);

  // Find the nightclub comparison job(s).
  const club = all.filter((g) =>
    /night ?club|dj booth|choker|red haze|onyx/i.test(g.params?.prompt || "")
  );
  console.log("club matches:", club.length);
  for (const g of club) {
    console.log("---", g.id, g.model, new Date(g.createdAt * 1000).toISOString());
    console.log(JSON.stringify(g.params, null, 2).slice(0, 4000));
  }
  if (club.length) {
    await fs.writeFile(
      path.join(OUT_DIR, "mcp-club-jobs.json"),
      JSON.stringify(club, null, 2)
    );
    // Raw FNF payload for the club jobs (read-only).
    for (const g of club.slice(0, 4)) {
      try {
        const raw = await callTool("job_status", { jobId: g.id, sync: false, raw_data: true });
        await fs.writeFile(
          path.join(OUT_DIR, `mcp-rawjob-${g.id}.json`),
          JSON.stringify(raw, null, 2)
        );
        console.log(`raw job saved: mcp-rawjob-${g.id}.json`);
      } catch (e: any) {
        console.log(`raw job ${g.id} failed:`, e.message?.slice(0, 200));
      }
    }
  } else {
    // Fall back: raw payload of the newest pair for batch/param forensics.
    for (const g of all.slice(0, 2)) {
      try {
        const raw = await callTool("job_status", { jobId: g.id, sync: false, raw_data: true });
        await fs.writeFile(
          path.join(OUT_DIR, `mcp-rawjob-${g.id}.json`),
          JSON.stringify(raw, null, 2)
        );
        console.log(`raw job saved: mcp-rawjob-${g.id}.json`);
      } catch (e: any) {
        console.log(`raw job ${g.id} failed:`, e.message?.slice(0, 200));
      }
    }
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
