/**
 * Council recon probe (READ-ONLY) — Phase 2.3 of the style-drift/video-quality
 * plan. Same technique as .council/higgsfield-nbp-parity/probe-mcp-history.ts
 * and probe-mcp-models.ts (image-side research, 2026-07-08), applied to video:
 * paginate the account's Seedance job history via show_generations(type:
 * "video"), pull raw FNF payloads via job_status(raw_data:true), and dump the
 * full video model catalog via models_explore — to separate "fixable by
 * engineering" (something our own pipeline can do) from "access-tier ceiling"
 * (something only available through Higgsfield's own infra/account tier).
 *
 * Tool whitelist is enforced in code (callTool throws on anything else) —
 * show_generations, job_status and models_explore are all annotated
 * readOnlyHint:true in the account's own tools/list (see
 * ../higgsfield-nbp-parity/mcp-tools-full.json lines ~62, ~7284, ~8139).
 * Zero credits spent; no generate_* call is ever made.
 *
 * Run: npx tsx .council/higgsfield-video-parity/probe-mcp-video.js
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const MCP_URL = "https://mcp.higgsfield.ai/mcp";
const TOKEN_URL = "https://mcp.higgsfield.ai/oauth2/token";
const TOKEN_FILE = path.join(process.cwd(), ".higgsfield-mcp-token.json");
const OUT_DIR = path.join(process.cwd(), ".council/higgsfield-video-parity");

let token = null;
let session = null;

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
  if (!j.access_token) throw new Error("token refresh failed: " + JSON.stringify(j));
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
function parseMsgs(text, ct) {
  if (!ct.includes("text/event-stream")) {
    try {
      return [JSON.parse(text)];
    } catch {
      return [];
    }
  }
  const out = [];
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
async function rpc(method, params, notif = false) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${await accessToken()}`,
  };
  if (session) headers["Mcp-Session-Id"] = session;
  const id = notif ? undefined : Math.floor(Math.random() * 1e9);
  const body = { jsonrpc: "2.0", method, params };
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
    clientInfo: { name: "lumina-council-probe-video", version: "0.1" },
  });
  await rpc("notifications/initialized", {}, true);
}
const READ_ONLY_TOOLS = new Set(["show_generations", "job_status", "models_explore"]);
async function callTool(name, args) {
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
  await fs.mkdir(OUT_DIR, { recursive: true });

  // 1) Full video model catalog — what video models exist at all on this
  //    account, before narrowing to Seedance specifically. This is what
  //    answers "is there an exclusive/hidden Seedance variant" empirically
  //    rather than by assumption.
  console.log("== models_explore: list, type=video ==");
  const listRes = await callTool("models_explore", { action: "list", type: "video" });
  const listSc = listRes.structuredContent ?? listRes;
  await fs.writeFile(
    path.join(OUT_DIR, "mcp-models-video.json"),
    JSON.stringify(listSc, null, 2)
  );
  const videoModels = listSc?.models ?? listSc?.items ?? [];
  console.log(`total video models: ${Array.isArray(videoModels) ? videoModels.length : "?"}`);
  const seedanceModels = (Array.isArray(videoModels) ? videoModels : []).filter((m) =>
    /seedance/i.test(m?.id || m?.model_id || m?.name || "")
  );
  console.log(
    "seedance-related model ids:",
    seedanceModels.map((m) => m.id || m.model_id).join(", ") || "(none found in list — falling back to known ids)"
  );

  // 2) get-detail catalog dump for every seedance-related id we know about
  //    (from the app's own MODEL_IDS map) plus anything the list surfaced
  //    that we didn't already know about.
  const knownIds = ["seedance_2_0", "seedance_2_0_mini"];
  const discoveredIds = seedanceModels.map((m) => m.id || m.model_id).filter(Boolean);
  const allIds = [...new Set([...knownIds, ...discoveredIds])];
  console.log("== models_explore: get detail for each seedance id ==", allIds);
  for (const id of allIds) {
    try {
      const r = await callTool("models_explore", { action: "get", model_id: id });
      const sc = r.structuredContent ?? r;
      await fs.writeFile(path.join(OUT_DIR, `mcp-model-${id}.json`), JSON.stringify(sc, null, 2));
      console.log("WROTE", id);
    } catch (e) {
      console.log(id, "FAILED:", e.message?.slice(0, 200));
    }
  }

  // 3) Paginate the account's real video job history.
  console.log("== show_generations: paginating type=video ==");
  const all = [];
  let cursor;
  for (let page = 0; page < 12; page++) {
    const args = { type: "video", size: 100 };
    if (cursor != null) args.cursor = cursor;
    const r = await callTool("show_generations", args);
    const sc = r?.structuredContent || {};
    const items = sc.items ?? [];
    all.push(...items);
    console.log(`page ${page}: ${items.length} items, next_cursor=${sc.next_cursor}`);
    if (sc.next_cursor == null || items.length === 0) break;
    cursor = sc.next_cursor;
  }
  await fs.writeFile(path.join(OUT_DIR, "mcp-history-video-all.json"), JSON.stringify(all, null, 2));
  console.log("total video jobs:", all.length);

  const seedanceJobs = all.filter((g) => /seedance/i.test(g.model || ""));
  console.log("seedance jobs:", seedanceJobs.length, "/ total video jobs:", all.length);
  await fs.writeFile(
    path.join(OUT_DIR, "mcp-history-seedance.json"),
    JSON.stringify(seedanceJobs, null, 2)
  );

  // Histogram: model, resolution/duration if present in params, generate_audio.
  const byModel = {};
  for (const g of seedanceJobs) {
    byModel[g.model] = (byModel[g.model] || 0) + 1;
  }
  console.log("by model:", byModel);

  // 4) Raw FNF payloads for a spread of seedance jobs (oldest, newest, and a
  //    few in between) — enough to check prompt verbatim-ness, param shape,
  //    and whether Lumina's own jobs (recognizable by our directive
  //    preamble) are visible in the same history as manually-authored ones.
  const sample = [];
  if (seedanceJobs.length) {
    sample.push(seedanceJobs[0]); // newest (API returns newest-first per the image probe's convention)
    if (seedanceJobs.length > 1) sample.push(seedanceJobs[seedanceJobs.length - 1]); // oldest
    const mid = seedanceJobs[Math.floor(seedanceJobs.length / 2)];
    if (mid && !sample.includes(mid)) sample.push(mid);
    // Also grab up to 3 more spread across the set for param-shape variety.
    for (let i = 1; i <= 3; i++) {
      const idx = Math.floor((seedanceJobs.length * i) / 4);
      const g = seedanceJobs[idx];
      if (g && !sample.includes(g)) sample.push(g);
    }
  }
  console.log(`pulling raw payloads for ${sample.length} sample job(s)`);
  for (const g of sample) {
    try {
      const raw = await callTool("job_status", { jobId: g.id, sync: false, raw_data: true });
      await fs.writeFile(
        path.join(OUT_DIR, `mcp-rawjob-${g.id}.json`),
        JSON.stringify(raw, null, 2)
      );
      console.log(`raw job saved: mcp-rawjob-${g.id}.json (model=${g.model})`);
    } catch (e) {
      console.log(`raw job ${g.id} failed:`, e.message?.slice(0, 200));
    }
  }

  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
