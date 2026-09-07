import { seedreamSize } from "../seedream";
import { providerModelId } from "../model-registry";
export function seedreamPayload({ prompt, resolution, aspectRatio, references = [] }, env = process.env) {
  if (!prompt?.trim()) throw new Error("Prompt is required.");
  if (references.length > 10) throw new Error("Seedream accepts at most 10 references.");
  return { model: providerModelId("seedream-5-pro", env), prompt, size: seedreamSize(resolution, aspectRatio), response_format: "url", output_format: "png", watermark: false, optimize_prompt_options: { mode: "standard" }, ...(references.length ? { image: references } : {}) };
}
export async function generateImageSeedream(input, { signal, fetchImpl = fetch, env = process.env } = {}) {
  if (!env.ARK_API_KEY || env.ARK_API_KEY === "[SENSITIVE]") throw new Error("Seedream is not configured: ARK_API_KEY is missing or redacted.");
  const body = seedreamPayload(input, env);
  // Exactly one submission. Ambiguous transport errors/timeouts must not retry.
  let response;
  try {
    response = await fetchImpl(`${(env.ARK_BASE_URL || "https://ark.ap-southeast.bytepluses.com/api/v3").replace(/\/$/, "")}/images/generations`, {
      method: "POST", headers: { Authorization: `Bearer ${env.ARK_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
    });
  } catch { throw new Error("Seedream connection ended without a confirmed result. The request may have been charged; it was not resubmitted."); }
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.error) {
    const code = String(result?.error?.code ?? "provider_error").replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 100);
    const message = code === "ModelNotOpen" ? "Enable Seedream 5.0 Pro in this account’s ModelArk console." : response.status === 429 ? "Seedream rate limit reached. Try again later." : response.status === 401 || response.status === 403 ? "Seedream authentication or model access failed." : "Seedream rejected the request. Check reference files and content requirements.";
    throw Object.assign(new Error(`${message} (${response.status}, ${code})`), { code, status: response.status });
  }
  const url = result?.data?.[0]?.url;
  if (result?.data?.length !== 1 || typeof url !== "string" || !url.startsWith("https://")) throw new Error("Seedream returned no valid single-image result. The request was not resubmitted.");
  const downloaded = await fetchImpl(url, { signal });
  if (!downloaded.ok) throw new Error(`Seedream produced an image but download failed (${downloaded.status}). The request was not resubmitted.`);
  return Buffer.from(await downloaded.arrayBuffer());
}
