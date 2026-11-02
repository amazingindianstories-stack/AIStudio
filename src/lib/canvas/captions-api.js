import { apiFetch } from "../api";

/**
 * Board video captions (backend/apps/canvas/caption_views.py). The VTT is fetched through the API as same-origin
 * text and handed to the video as a blob URL, so the video never needs crossOrigin (which would break CDN redirects).
 */
const base = (boardId) => `/api/canvas-boards/${encodeURIComponent(boardId)}/captions`;
const withSrc = (path, src) => `${path}?src=${encodeURIComponent(src)}`;

async function readJson(response) {
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(json.error || `Request failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return json;
}

export async function quoteCaptions(boardId, src, fetchImpl = apiFetch) {
  const json = await readJson(await fetchImpl(withSrc(base(boardId), src), { cache: "no-store" }));
  return json.captions;
}

export async function generateCaptions(boardId, src, fetchImpl = apiFetch) {
  const json = await readJson(await fetchImpl(base(boardId), {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ src }),
  }));
  return json.captions;
}

/** A blob URL for the stored VTT; the caller revokes it. */
export async function loadCaptionTrack(boardId, src, fetchImpl = apiFetch, urls = URL) {
  const response = await fetchImpl(withSrc(`${base(boardId)}/vtt`, src), { cache: "no-store" });
  if (!response.ok) {
    const json = await response.json().catch(() => ({}));
    throw new Error(json.error || `Request failed: ${response.status}`);
  }
  const text = await response.text();
  return urls.createObjectURL(new Blob([text], { type: "text/vtt" }));
}

/** The cost step's wording. Transcription has no metered price in Veevee, so none is invented. */
export function costLabel(quote) {
  const model = quote?.model || "the speech-to-text provider";
  const cents = Number(quote?.costCents) || 0;
  return cents > 0
    ? `Uses ${model}. Estimated cost: ${(cents / 100).toFixed(2)} USD.`
    : `Uses ${model}. No price is metered in Veevee for this step.`;
}
