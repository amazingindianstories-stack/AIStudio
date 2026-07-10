/** READ-ONLY: recent video generations (show_generations) + raw job params for
 *  seedance_2_0_mini jobs, plus get_cost preflights for mini at several
 *  durations. Reuses the current access token WITHOUT refreshing. */
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const MCP_URL = "https://mcp.higgsfield.ai/mcp";
const TOKEN_FILE = path.join(process.cwd(), ".higgsfield-mcp-token.json");
const OUT = path.join(process.cwd(), ".council/seedance-mini");
const TMP = path.join(process.env.TMPDIR || "/tmp", `hf-mini-${process.pid}`);
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

const READONLY = new Set(["show_generations", "job_status"]);
async function callTool(name: string, args: any): Promise<any> {
  // generate_video is allowed ONLY with get_cost:true (preflight, no job).
  if (!READONLY.has(name) && !(name === "generate_video" && args?.params?.get_cost === true)) {
    throw new Error("BLOCKED (read-only probe): " + name);
  }
  const r = await rpc("tools/call", { name, arguments: args });
  return r;
}

async function main() {
  access = JSON.parse(await fs.readFile(TOKEN_FILE, "utf8")).access_token;
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vivi-mini-audit", version: "0.1" } });
  await rpc("notifications/initialized", {}, true);

  // 1) recent generations
  const hist = await callTool("show_generations", { type: "video", limit: 20 });
  await fs.writeFile(path.join(OUT, "mcp-videohistory.json"), JSON.stringify(hist, null, 2));
  const gens = hist?.structuredContent?.generations || hist?.structuredContent?.results || [];
  console.log("recent video jobs:", gens.length);
  for (const g of gens.slice(0, 10)) {
    console.log(`- ${g.id?.slice(0, 8)} model=${g.model ?? g.model_id} status=${g.status} created=${g.created_at ?? g.createdAt ?? "?"}`);
  }

  // 2) raw params for the mini jobs
  const miniJobs = gens.filter((g: any) => /mini/i.test(String(g.model ?? g.model_id ?? "")));
  for (const g of miniJobs.slice(0, 4)) {
    const raw = await callTool("job_status", { jobId: g.id, sync: false, raw_data: true });
    await fs.writeFile(path.join(OUT, `mcp-minijob-${g.id}.json`), JSON.stringify(raw, null, 2));
    const gg = raw?.structuredContent?.generation ?? raw?.structuredContent ?? {};
    console.log(`\n== mini job ${g.id}`);
    console.log(JSON.stringify(gg.params ?? gg.raw ?? gg, null, 1).slice(0, 1200));
  }

  // 3) get_cost preflights
  for (const [duration, resolution] of [[15, "720p"], [12, "720p"], [5, "720p"], [5, "480p"]] as const) {
    try {
      const r = await callTool("generate_video", {
        params: { model: "seedance_2_0_mini", prompt: "cost preflight", duration, resolution, get_cost: true },
      });
      const txt = (r?.content || []).map((c: any) => c?.text || "").join(" ");
      console.log(`get_cost mini d=${duration} ${resolution}:`, JSON.stringify(r?.structuredContent ?? txt).slice(0, 250));
    } catch (e: any) {
      console.log(`get_cost mini d=${duration} ${resolution} FAILED:`, String(e?.message).slice(0, 150));
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e?.message || e); process.exit(1); });
