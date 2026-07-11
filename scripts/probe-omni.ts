/**
 * Probe script for Gemini Omni Flash (gemini-omni-flash-preview) — the
 * Interactions API contract used by src/lib/providers/omni.ts. Confirms the
 * PROBE VERDICTS documented in that file's header still hold.
 *
 * Every probe below keeps `input: []`, which the API rejects with "Missing
 * input." before doing anything else — so these are genuinely zero-cost,
 * unlike sending a real (even malformed) prompt/content array, which this
 * API will happily run to completion and bill for (a non-array `input` and
 * a `{type:"text"}` item with no `text` field both triggered real paid
 * generations during the 2026-07-11 rediscovery of this contract — do not
 * "probe" by sending a non-empty input array outside of --live).
 *
 * Usage:
 *   npx tsx scripts/probe-omni.ts            # zero-cost matrix + Vertex readiness
 *   npx tsx scripts/probe-omni.ts --live      # + one real ~4s generation (~$0.40)
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const MODEL = process.env.OMNI_MODEL || "gemini-omni-flash-preview";

async function post(body: unknown) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_API_KEY is not set in .env.local.");
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

async function probeZeroCost() {
  console.log("=== Zero-cost validation matrix (generativelanguage, input always []) ===\n");

  console.log("-- Probe 1: `input: []` alone (expect 400 'Missing input.' — the safe baseline) --");
  const r1 = await post({ model: MODEL, input: [] });
  console.log(`status=${r1.status}`, r1.text.slice(0, 300), "\n");

  console.log("-- Probe 2: `task` field (expect 400 'Unknown parameter' — this field does NOT exist) --");
  const r2 = await post({ model: MODEL, input: [], task: "text_to_video" });
  console.log(`status=${r2.status}`, r2.text.slice(0, 300), "\n");

  console.log("-- Probe 3: `delivery` field (expect 400 'Unknown parameter' — this field does NOT exist) --");
  const r3 = await post({ model: MODEL, input: [], delivery: "inline" });
  console.log(`status=${r3.status}`, r3.text.slice(0, 300), "\n");

  console.log("-- Probe 4: invalid response_format.aspect_ratio (confirms enum is exactly 16:9/9:16) --");
  const r4 = await post({
    model: MODEL,
    input: [],
    response_format: { type: "video", aspect_ratio: "NOT_A_REAL_RATIO" },
  });
  console.log(`status=${r4.status}`, r4.text.slice(0, 400), "\n");

  console.log("-- Probe 5: response_format.duration as a bare number (expect 400 — must be a Duration string like \"4s\") --");
  const r5 = await post({
    model: MODEL,
    input: [],
    response_format: { type: "video", aspect_ratio: "16:9", duration: 4 },
  });
  console.log(`status=${r5.status}`, r5.text.slice(0, 300), "\n");

  console.log("-- Probe 6: response_format.duration as a Duration string (expect 400 'Missing input.' — the field itself validates) --");
  const r6 = await post({
    model: MODEL,
    input: [],
    response_format: { type: "video", aspect_ratio: "16:9", duration: "4s" },
  });
  console.log(`status=${r6.status}`, r6.text.slice(0, 300), "\n");

  console.log("-- Probe 7: response_format.resolution (expect 400 'Unknown parameter' — resolution is not controllable) --");
  const r7 = await post({
    model: MODEL,
    input: [],
    response_format: { type: "video", resolution: "720p" },
  });
  console.log(`status=${r7.status}`, r7.text.slice(0, 300), "\n");

  console.log("-- Probe 8: camelCase mimeType on an image part (expect 400 'Did you mean mime_type?') --");
  const r8 = await post({ model: MODEL, input: [{ type: "image", mimeType: "image/png", data: "AAAA" }] });
  console.log(`status=${r8.status}`, r8.text.slice(0, 300), "\n");
}

async function probeVertexReadiness() {
  console.log("=== Vertex readiness check ===\n");
  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (!project) {
    console.log("GOOGLE_CLOUD_PROJECT not set — skipping Vertex check. Set it plus " +
      "GOOGLE_APPLICATION_CREDENTIALS (or run `gcloud auth application-default login`) to test.\n");
    return;
  }
  try {
    const { GoogleAuth } = await import("google-auth-library");
    const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
    const token = await auth.getAccessToken();
    if (!token) {
      console.log("No access token obtained — Vertex creds are not usable.\n");
      return;
    }
    const url = `https://aiplatform.googleapis.com/v1beta1/projects/${project}/locations/global/interactions`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: MODEL, input: [] }),
    });
    const text = await res.text();
    console.log(`status=${res.status}`, text.slice(0, 500));
    if (res.status === 401) console.log("→ Vertex creds are dead/expired.");
    else if (res.status === 403) console.log("→ Vertex creds are valid but Omni access is allowlist-gated for this project.");
    else if (res.status === 400) console.log("→ Vertex creds + access look usable (this is the expected validation error).");
    console.log();
  } catch (e: any) {
    console.log(`Vertex check failed: ${e?.message || e}\n`);
  }
}

async function probeLive() {
  console.log("=== LIVE generation (real spend, ~$0.40 for a 4s clip) ===\n");
  const { createOmniVideoTask, getOmniVideoStatus } = await import("../src/lib/providers/omni");
  const taskId = await createOmniVideoTask({
    assembled: { instruction: "A single candle flame flickering gently in a dark room.", groups: [] },
    aspectRatio: "16:9",
    duration: 4,
  });
  console.log(`Created interaction: ${taskId}`);

  for (let poll = 1; poll <= 30; poll++) {
    await new Promise((r) => setTimeout(r, 4000));
    const result = await getOmniVideoStatus(taskId);
    console.log(`poll ${poll}: ${result.status}`);
    if (result.status === "succeeded" && result.videoBase64) {
      const fs = await import("fs/promises");
      const path = await import("path");
      const outDir = path.join(process.cwd(), ".council", "omni-video");
      await fs.mkdir(outDir, { recursive: true });
      const outPath = path.join(outDir, "live-test.mp4");
      await fs.writeFile(outPath, Buffer.from(result.videoBase64, "base64"));
      console.log(`saved base64 video -> ${outPath} (${result.mimeType})`);
      return;
    }
    if (result.status === "failed") {
      console.log(`FAILED: ${result.error}`);
      return;
    }
  }
  console.log("Gave up after 30 polls (~2 minutes) — check the interaction manually.");
}

async function main() {
  await probeZeroCost();
  await probeVertexReadiness();
  if (process.argv.includes("--live")) {
    await probeLive();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
