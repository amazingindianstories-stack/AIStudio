import { inlineMediaUrl } from "./utils";

/** Helpers for the Portrait Gallery: ordering, paging, upload ordering, copy and download. */

export const PORTRAIT_MAX_BYTES = 30 * 1024 * 1024;
export const PORTRAIT_BATCH_LIMIT = 50;
export const PORTRAIT_UPLOAD_CONCURRENCY = 3;
export const PORTRAIT_POLL_FIRST_MS = 3000;
export const PORTRAIT_POLL_MAX_MS = 15000;

/** Newest first, ties broken by id: the order the server pages in. */
export function comparePortraits(a, b) {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export function sortPortraits(items) {
  return [...items].sort(comparePortraits);
}

/** Portraits still moving through the server-side queue. */
export function isPortraitPending(item) {
  return item?.state === "preparing" || item?.state === "waiting";
}

/** A portrait can be put in a prompt unless the server marked it unusable. */
export function portraitAttachable(item) {
  return Boolean(item?.imageUrl) && item.state !== "unusable";
}

/** Delay before the next status poll: 3 s, easing out to 15 s while nothing changes. */
export function portraitPollDelay(attempt) {
  return Math.min(PORTRAIT_POLL_MAX_MS, Math.round(PORTRAIT_POLL_FIRST_MS * 1.5 ** Math.max(0, attempt)));
}

/**
 * Folds a freshly fetched first page into the list already on screen. Items
 * inside the range that page covers are replaced by it (so removed ones drop
 * out); items older than the page's last entry came from later pages and stay,
 * and then the cursor already held for those pages stays valid (`keepNext`).
 */
export function mergePortraitPage(current, page, next) {
  const incoming = sortPortraits(page);
  const boundary = next && incoming.length ? incoming[incoming.length - 1] : null;
  const known = new Set(incoming.map((item) => item.id));
  const older = boundary
    ? current.filter((item) => !known.has(item.id) && comparePortraits(boundary, item) < 0)
    : [];
  return { items: [...incoming, ...older], keepNext: older.length > 0 };
}

/** Appends a further page, never duplicating an item that moved between pages. */
export function appendPortraitPage(current, page) {
  const known = new Set(current.map((item) => item.id));
  return [...current, ...page.filter((item) => !known.has(item.id))];
}

export function portraitNameFromFile(file) {
  const base = String(file?.name || "").replace(/\.[^.]+$/, "").trim();
  return (base || "Portrait").slice(0, 120);
}

/** Client-side refusal for a file before any bytes are sent; null when acceptable. */
export function portraitFileProblem(file) {
  const type = String(file?.type || "");
  if (type && !type.startsWith("image/")) return "Only image files can be portraits.";
  if (!type && !/\.(jpe?g|png|webp|gif|heic|heif|avif|bmp|tiff?)$/i.test(String(file?.name || ""))) return "Only image files can be portraits.";
  if (!file?.size) return "This file is empty.";
  if (file.size > PORTRAIT_MAX_BYTES) return "This image is larger than 30 MB. Use a smaller version.";
  return null;
}

/**
 * Registers uploads in the order the person gave them even though the bytes
 * finish out of order. `settle(index, entry)` is called once per file (entry is
 * null when the upload failed); every contiguous run of settled files starting
 * at the first unregistered one is sent, in order and at most 50 at a time, and
 * the sends are serialized so the server stamps them in that same order.
 */
export function createOrderedRegistrar(total, register) {
  const settled = new Array(total).fill(undefined);
  let next = 0;
  let chain = Promise.resolve();
  return {
    settle(index, entry) {
      settled[index] = entry ?? null;
      const batch = [];
      while (next < total && settled[next] !== undefined) {
        if (settled[next]) batch.push({ index: next, ...settled[next] });
        next += 1;
      }
      for (let at = 0; at < batch.length; at += PORTRAIT_BATCH_LIMIT) {
        const chunk = batch.slice(at, at + PORTRAIT_BATCH_LIMIT);
        chain = chain.then(() => register(chunk));
      }
      return chain;
    },
    done: () => chain,
  };
}

/** Runs `worker(item, index)` over `items` with bounded concurrency. */
export async function runPool(items, concurrency, worker) {
  let cursor = 0;
  const lane = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
}

/** Library items dragged in: only finished images with a URL become portraits. */
export function portraitDropImages(items) {
  return (Array.isArray(items) ? items : []).filter((item) => item?.kind === "image" && item.url);
}

/** User copy for the state chip on a portrait card; null when ready. */
export function portraitStateLabel(item) {
  if (item.state === "preparing") return "Preparing";
  if (item.state === "waiting") return "Waiting for space";
  if (item.state === "unusable") return "Can't be used";
  return null;
}

const EXTENSION_BY_TYPE = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" };

/** Saves the original image under the portrait's name. */
export async function downloadPortrait(portrait) {
  if (!portrait?.imageUrl) return;
  try {
    const res = await fetch(inlineMediaUrl(portrait.imageUrl));
    if (!res.ok) throw new Error("Download failed");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${(portrait.name || "portrait").replace(/\s+/g, "-")}.${EXTENSION_BY_TYPE[blob.type] || "png"}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  } catch {
    window.open(portrait.imageUrl, "_blank");
  }
}
