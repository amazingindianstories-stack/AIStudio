/** READ-ONLY probe: find the Seedance mini 720p model on the Higgsfield MCP
 *  and dump its schema/limits. curl transport (Node 26 undici can't read this
 *  server's aborted SSE streams); always refresh the token first (stale
 *  tokens 401 disguised as generic errors). */
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const MCP_URL = "https://mcp.higgsfield.ai/mcp";
const TOKEN_URL = "https://mcp.higgsfield.ai/oauth2/token";
const TOKEN_FILE = path.join(process.cwd(), ".higgsfield-mcp-token.json");
const OUT = path.join(process.cwd(), ".council/seedance-mini");
const TMP = path.join(process.env.TMPDIR || "/tmp", `hf-sdm-${process.pid}`);

let token: any = null;
let session: string | null = null;

async function refreshToken() {
  const t = JSON.parse(await fs.readFile(TOKEN_FILE, "utf8"));
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
  token = { ...t, access_token: j.access_token, refresh_token: j.refresh_token || t.refresh_token, obtained_at: Date.now() };
  await fs.writeFile(TOKEN_FILE, JSON.stringify(token, null, 2));
}

function parseMessages(text: string): any[] {
  const out: any[] = [];
  for (const ev of text.split(/\r?\n\r?\n/)) {
    const data = ev.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
    if (data) { try { out.push(JSON.parse(data)); } catch {} }
  }
  if (!out.length) { try { out.push(JSON.parse(text)); } catch {} }
  return out;
}

async function rpc(method: string, params: unknown, notif = false): Promise<any> {
  await fs.mkdir(TMP, { recursive: true });
  const reqId = notif ? undefined : Math.floor(Math.random() * 1e9);
  const body: any = { jsonrpc: "2.0", method, params };
  if (reqId !== undefined) body.id = reqId;
  const hdr = [`Content-Type: application/json`, `Accept: application/json, text/event-stream`, `Authorization: Bearer ${token.access_token}`];
  if (session) hdr.push(`Mcp-Session-Id: ${session}`);
  await fs.writeFile(path.join(TMP, "h.txt"), hdr.join("\n") + "\n");
  await fs.writeFile(path.join(TMP, "b.json"), JSON.stringify(body));
  let stdout = "";
  try {
    const r = await execFileP("curl", ["--http1.1", "-s", "-N", "--max-time", "90", "-H", `@${TMP}/h.txt`, "-D", `${TMP}/rh.txt`, "--data-binary", `@${TMP}/b.json`, MCP_URL], { maxBuffer: 64 * 1024 * 1024 });
    stdout = r.stdout;
  } catch (e: any) {
    stdout = e?.stdout ?? "";
    if (!stdout) throw new Error(`curl exit ${e?.code}, no body`);
  }
  try {
    const rh = await fs.readFile(`${TMP}/rh.txt`, "utf8");
    const sid = rh.match(/^mcp-session-id:\s*(.+)$/im)?.[1]?.trim();
    if (sid) session = sid;
  } catch {}
  if (notif) return null;
  const ans = parseMessages(stdout).find((m) => m?.id === reqId);
  if (!ans) throw new Error(`${method}: no response — ${stdout.slice(0, 150)}`);
  if (ans.error) throw new Error(`${method}: ${JSON.stringify(ans.error).slice(0, 250)}`);
  return ans.result;
}

async function callTool(name: string, args: unknown): Promise<any> {
  if (name !== "models_explore") throw new Error("BLOCKED (read-only probe): " + name);
  const r = await rpc("tools/call", { name, arguments: args });
  const txt = (r?.content || []).map((c: any) => c?.text || "").join("\n");
  if (r?.isError) throw new Error(`${name}: ${txt.slice(0, 300)}`);
  return r;
}

async function main() {
  const cur = JSON.parse(await fs.readFile(TOKEN_FILE, "utf8"));
  // Refresh rotates the family and races prod — only when actually stale.
  if (!cur.obtained_at || Date.now() - cur.obtained_at > 12 * 3600_000) await refreshToken();
  else token = cur;
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vivi-seedance-probe", version: "0.1" } });
  await rpc("notifications/initialized", {}, true);

  // 1) list video models
  const list = await callTool("models_explore", { action: "list", type: "video" });
  await fs.writeFile(path.join(OUT, "mcp-models-video.json"), JSON.stringify(list, null, 2));
  const listText = (list?.content || []).map((c: any) => c?.text || "").join("\n");
  const seedanceLines = listText.split("\n").filter((l: string) => /seedance|mini/i.test(l));
  console.log("video models mentioning seedance/mini:\n" + seedanceLines.join("\n"));

  // 2) fetch schema for every seedance-ish id we can spot
  const ids = Array.from(new Set([...listText.matchAll(/\b([a-z0-9_]*seedance[a-z0-9_]*)\b/gi)].map((m) => m[1].toLowerCase())));
  console.log("candidate ids:", ids.join(", ") || "(none spotted — check json)");
  for (const id of ids) {
    try {
      const r = await callTool("models_explore", { action: "get", model_id: id });
      await fs.writeFile(path.join(OUT, `mcp-model-${id}.json`), JSON.stringify(r, null, 2));
      console.log(`saved mcp-model-${id}.json`);
    } catch (e: any) {
      console.log(`get ${id} failed: ${String(e?.message).slice(0, 120)}`);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e?.message || e); process.exit(1); });
