/** READ-ONLY: raw job data for the two seedance_2_0_mini jobs — what
 *  duration/params the server recorded, and any unlimited/SKU markers. */
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const MCP_URL = "https://mcp.higgsfield.ai/mcp";
const TOKEN_FILE = path.join(process.cwd(), ".higgsfield-mcp-token.json");
const OUT = path.join(process.cwd(), ".council/seedance-mini");
const TMP = path.join(process.env.TMPDIR || "/tmp", `hf-raw-${process.pid}`);
let session: string | null = null;
let access = "";

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
  const hdr = ["Content-Type: application/json", "Accept: application/json, text/event-stream", `Authorization: Bearer ${access}`];
  if (session) hdr.push(`Mcp-Session-Id: ${session}`);
  await fs.writeFile(path.join(TMP, "h.txt"), hdr.join("\n") + "\n");
  await fs.writeFile(path.join(TMP, "b.json"), JSON.stringify(body));
  let stdout = "";
  try {
    const r = await execFileP("curl", ["--http1.1", "-s", "-N", "--max-time", "90", "-H", `@${TMP}/h.txt`, "-D", `${TMP}/rh.txt`, "--data-binary", `@${TMP}/b.json`, MCP_URL], { maxBuffer: 64 * 1024 * 1024 });
    stdout = r.stdout;
  } catch (e: any) {
    stdout = e?.stdout ?? "";
    if (!stdout) throw new Error(`curl exit ${e?.code}`);
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

async function main() {
  access = JSON.parse(await fs.readFile(TOKEN_FILE, "utf8")).access_token;
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vivi-mini-raw", version: "0.1" } });
  await rpc("notifications/initialized", {}, true);
  for (const id of ["8a1f0303-96e5-4565-bee8-f2590960ffdf", "023b3165-db32-4a61-b05f-018cad8b6222"]) {
    const raw = await rpc("tools/call", { name: "job_status", arguments: { jobId: id, sync: false, raw_data: true } });
    await fs.writeFile(path.join(OUT, `mcp-minijob-${id.slice(0, 8)}.json`), JSON.stringify(raw, null, 2));
    const txt = (raw?.content || []).map((c: any) => c?.text || "").join("\n");
    const sc = raw?.structuredContent;
    console.log(`==== ${id.slice(0, 8)} ====`);
    console.log(JSON.stringify(sc ?? {}, null, 1).slice(0, 1600));
    if (txt) console.log("TEXT:", txt.slice(0, 800));
    console.log();
  }
  process.exit(0);
}
main().catch((e) => { console.error(e?.message || e); process.exit(1); });
