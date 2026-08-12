/**
 * Pre-generated thumbnail derivatives.
 *
 * `/api/media/[...path]?w=N` used to resize on every read: a sharp decode +
 * webp encode per grid card, per view, forever, on the same shared fluid-compute
 * instance that every other request contends for. Nothing about that work is
 * request-specific — the source object is immutable, so the answer for a given
 * (key, width) never changes — which makes it work that belongs on the write
 * path exactly once.
 *
 * Derivatives are stored beside the original in the same bucket, so serving one
 * is the same signed-redirect the original gets and the function moves no bytes
 * and burns no CPU.
 *
 * The ladder is deliberately short. Call sites ask for six distinct widths
 * (128/160/320/480 for cards and panels, 1024/1200 for canvas nodes and the
 * conversation feed); rendering six derivatives to serve them exactly would
 * quadruple write cost to save a downscale the browser does for free. Each
 * request is served the smallest ladder step that is at least as wide as it
 * asked for, so an image is never upscaled and never arrives softer than the
 * old behaviour.
 */
export const THUMB_LADDER = [512, 1280] ;

/** Extensions we can rasterise. A key outside this set (mp4, webm, json) has no
 * derivative and must be served as-is. */
const RASTER_EXT = new Set(["png", "jpg", "jpeg", "webp", "gif"]);

export const THUMB_PREFIX = "thumbs/";

export function keyExtension(key) {
  const base = key.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
}

/** Whether a stored object can have thumbnail derivatives at all. Derivatives
 * are themselves objects in the bucket, so they must never recurse. */
export function isThumbnailable(key) {
  if (key.startsWith(THUMB_PREFIX)) return false;
  return RASTER_EXT.has(keyExtension(key));
}

/**
 * The ladder step that serves a request for `width`, or null when the request
 * is wide enough that the original is the right answer. Returning null rather
 * than the largest step matters: a 1600-wide request served a 1280 derivative
 * would be an upscale, which is the one way this could look worse than the
 * resize-on-read it replaces.
 */
export function thumbLadderWidth(width) {
  return THUMB_LADDER.find((step) => step >= width) ?? null;
}

/**
 * Storage key for a derivative. The original key is kept whole — extension
 * included — inside the derivative's path, so the mapping is unambiguous in
 * both directions and a bucket listing sorts derivatives next to nothing else.
 */
export function thumbKey(key, width) {
  return `${THUMB_PREFIX}${width}/${key}.webp`;
}

/** Inverse of `thumbKey`; null when `key` is not a derivative. */
export function originalKeyFromThumb(key) {
  if (!key.startsWith(THUMB_PREFIX)) return null;
  const rest = key.slice(THUMB_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash === -1) return null;
  const width = Number(rest.slice(0, slash));
  const original = rest.slice(slash + 1);
  if (!Number.isFinite(width) || !original.endsWith(".webp")) return null;
  return { key: original.slice(0, -".webp".length), width };
}
