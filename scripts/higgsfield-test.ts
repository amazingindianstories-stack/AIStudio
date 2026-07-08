/**
 * Higgsfield smoke test — verifies the keys work and checks whether the "Soul"
 * (photorealistic) model returns a realistic human face, i.e. whether it lets
 * through the kind of content Seedance/Nano-Banana moderate.
 *
 * Run:  npx tsx scripts/higgsfield-test.ts
 *
 * The official v2 SDK's poller doesn't match this endpoint's job-set response,
 * so we call the REST API directly:
 *   - base:  https://platform.higgsfield.ai
 *   - auth:  Authorization: Key <KEY_ID>:<KEY_SECRET>
 *   - body:  { params: { ...fields } }
 *   - POST /v1/text2image/soul  -> job-set { id, jobs:[{ status, results }] }
 *   - GET  /v1/job-sets/{id}    -> poll until queued/in_progress resolves
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

const BASE = "https://platform.higgsfield.ai";

function authHeader(): string {
  const keyId = process.env.HIGGSFIELD_API_KEY;
  const secret = process.env.HIGGSFIELD_SECRET;
  if (!keyId || !secret) {
    throw new Error("HIGGSFIELD_API_KEY / HIGGSFIELD_SECRET missing from .env.local");
  }
  return `Key ${keyId}:${secret}`;
}

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}: ${JSON.stringify(json)}`);
  }
  return json;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const prompt =
    "Photorealistic close-up portrait of a 30-year-old South Asian woman, " +
    "natural skin texture with pores and freckles, soft window light, shallow " +
    "depth of field, looking directly at the camera, ultra-detailed, 85mm lens.";

  console.log("→ Submitting Soul (photoreal) text-to-image…");
  console.log("  prompt:", prompt, "\n");

  const submit = await api("/v1/text2image/soul", {
    method: "POST",
    body: JSON.stringify({
      params: {
        prompt,
        width_and_height: "1152x1536",
        quality: "1080p",
        batch_size: 1,
        enhance_prompt: true,
      },
    }),
  });

  const jobSetId: string = submit.id;
  console.log("  job-set:", jobSetId, "→ polling…");

  let jobSet = submit;
  const deadline = Date.now() + 4 * 60 * 1000; // 4 min
  while (Date.now() < deadline) {
    const statuses = (jobSet.jobs ?? []).map((j: any) => j.status);
    if (statuses.every((st: string) => !["queued", "in_progress"].includes(st))) {
      break;
    }
    await sleep(3000);
    jobSet = await api(`/v1/job-sets/${jobSetId}`);
    process.stdout.write(`  · ${(jobSet.jobs ?? []).map((j: any) => j.status).join(",")}\n`);
  }

  const job = (jobSet.jobs ?? [])[0] ?? {};
  console.log("\n← final job status:", job.status);

  if (job.status === "completed") {
    const results = job.results ?? {};
    const url = results?.raw?.url || results?.url || results?.min?.url;
    console.log("\n✅ Realistic face ALLOWED. Image URL:");
    console.log("  " + (url ?? JSON.stringify(results)));
  } else if (job.status === "nsfw") {
    console.log("\n🚫 Blocked by Higgsfield moderation (status=nsfw).");
  } else {
    console.log("\n⚠️  Did not complete. Full job-set:");
    console.log(JSON.stringify(jobSet, null, 2));
  }

  process.exit(0);
}

main().catch((e) => {
  console.error("\n❌ Error:", e?.message || e);
  process.exit(1);
});
