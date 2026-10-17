import { inlineMediaUrl } from "./utils";
import { fetchRetryBusy } from "./api";

/** Helpers for the Portrait Gallery: ordering, paging, upload ordering, copy and download. */

export const PORTRAIT_MAX_BYTES = 30 * 1024 * 1024;
export const PORTRAIT_BATCH_LIMIT = 50;
export const PORTRAIT_MIN_SIDE = 300;
export const PORTRAIT_MAX_SIDE = 6000;
export const PORTRAIT_MIN_RATIO = 0.4;
export const PORTRAIT_MAX_RATIO = 2.5;
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
 *
 * Order also holds across drops: pass the previous drop's `finished` as `after`
 * and none of this drop's files are sent until every file of that earlier drop
 * has been registered, refused or failed. Order is strict within a drop; a
 * failed or refused file never blocks anything, and a slow upload only holds
 * back later drops until it settles. `finished` resolves once all `total`
 * files have settled and their sends are done.
 */
export function createOrderedRegistrar(total, register, after = Promise.resolve()) {
  const settled = new Array(total).fill(undefined);
  const gate = Promise.resolve(after).catch(() => {});
  let next = 0;
  let remaining = total;
  let chain = Promise.resolve();
  let allSettled;
  const everyone = new Promise((resolve) => { allSettled = resolve; });
  if (!total) allSettled();
  return {
    settle(index, entry) {
      if (settled[index] === undefined) remaining -= 1;
      settled[index] = entry ?? null;
      const batch = [];
      while (next < total && settled[next] !== undefined) {
        if (settled[next]) batch.push({ index: next, ...settled[next] });
        next += 1;
      }
      for (let at = 0; at < batch.length; at += PORTRAIT_BATCH_LIMIT) {
        const chunk = batch.slice(at, at + PORTRAIT_BATCH_LIMIT);
        chain = chain.then(() => gate).then(() => register(chunk));
      }
      if (remaining === 0) allSettled();
      return chain;
    },
    done: () => chain,
    finished: everyone.then(() => chain).catch(() => {}),
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
    const res = await fetchRetryBusy(inlineMediaUrl(portrait.imageUrl));
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

/** Short copy for an image whose size the portrait store would refuse (the tile shows the file name); null when it fits. */
export function portraitDimensionProblem(width, height) {
  if (!(width > 0) || !(height > 0)) return null;
  const size = `${width} x ${height} px`;
  if (Math.min(width, height) < PORTRAIT_MIN_SIDE) return `Too small (${size}). Use at least ${PORTRAIT_MIN_SIDE} px on each side.`;
  if (Math.max(width, height) > PORTRAIT_MAX_SIDE) return `Too large (${size}). Use at most ${PORTRAIT_MAX_SIDE} px on each side.`;
  const ratio = width / height;
  if (ratio > PORTRAIT_MAX_RATIO) return `Too wide (${size}). Crop it closer to the face.`;
  if (ratio < PORTRAIT_MIN_RATIO) return `Too tall (${size}). Crop it closer to the face.`;
  return null;
}

/** Reads the file's pixel size in the browser; null when it cannot be decoded here (the server then decides). */
export async function readPortraitDimensions(file) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close?.();
      return size;
    } catch {
      /* fall through to an <img> decode */
    }
  }
  if (typeof Image === "function" && typeof URL?.createObjectURL === "function") {
    const url = URL.createObjectURL(file);
    try {
      return await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = reject;
        image.src = url;
      });
    } catch {
      /* undecodable here, for example HEIC: let the server judge it */
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  return null;
}
