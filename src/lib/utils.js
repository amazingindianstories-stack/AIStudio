import { clsx, } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export function aspectToPadding(ratio) {
  const [w, h] = ratio.split(":").map(Number);
  if (!w || !h) return "56.25%";
  return `${(h / w) * 100}%`;
}

/**
 * The widest a media frame may be so that its height — which `aspectToPadding`
 * derives from that width — stays within `maxVh` of the viewport.
 *
 * Capping the WIDTH is what makes this work. The percentage-padding trick sizes
 * height from width, and a percentage padding cannot be expressed in viewport
 * units, so `max-height` on the frame would clamp the box without telling the
 * ratio, leaving the image letterboxed inside a frame of the wrong shape. Take
 * the width down instead and the height follows exactly, ratio intact.
 *
 * Applies to every ratio rather than just portrait ones: at a ~770px reading
 * column even 1:1 renders ~770px tall, which already overflows a laptop
 * viewport. Landscape ratios produce a cap wider than any column, so the
 * container's own width keeps winning and nothing changes for them.
 */
export function aspectMaxWidth(ratio, maxVh = MEDIA_MAX_VH) {
  const [w, h] = String(ratio ?? "").split(":").map(Number);
  // Unknown ratio: no cap, so an unparseable value degrades to today's
  // behaviour rather than to an arbitrarily narrow frame.
  if (!w || !h) return undefined;
  return `calc(${maxVh}vh * ${w / h})`;
}

/** Tall media in a scrolling thread should take most of the view but still
 *  show that it continues — a full-height frame reads as "the page is stuck".
 *  Deliberately not viewport-minus-chrome arithmetic: that hard-codes the
 *  composer and top bar heights into a layout helper and breaks silently when
 *  either changes. */
const MEDIA_MAX_VH = 62;

/** Append a `?w=` resize hint to a `/api/media/...` URL for grid/canvas
 * thumbnails — the media route resizes+re-encodes images on read (see
 * route.ts). Leaves non-media URLs (e.g. data: URLs, external URLs)
 * untouched since only our own proxy understands the param. */
export function thumbUrl(url, width) {
  if (!url) return undefined;
  if (!url.startsWith("/api/media/")) return url;
  const [base, hash] = url.split("#");
  const sep = base.includes("?") ? "&" : "?";
  const withWidth = `${base}${sep}w=${width}`;
  return hash ? `${withWidth}#${hash}` : withWidth;
}

/**
 * Resolves a reference image URI (asset://, /api/media/..., remote URL, data URL)
 * to a clean, displayable URL for browser <img> tags.
 *
 * - Resolves `asset://<id>` by looking up matching portrait in portraitAssets.
 * - Strips `#bp_asset_id=...` hash fragments so display URLs are clean.
 * - Strips any `?bp_asset_id=...` or `&bp_asset_id=...` query parameters from remote
 *   signed URLs (e.g. BytePlus TOS) to restore valid HMAC signatures.
 */
export function referenceDisplayUrl(url, portraitAssets = []) {
  if (!url || typeof url !== "string") return "";

  // 1. Resolve asset:// URIs to their viewable imageUrl
  if (url.startsWith("asset://")) {
    const assetId = url.slice("asset://".length).split(/[?&#]/)[0];
    const match = Array.isArray(portraitAssets)
      ? portraitAssets.find((a) => a?.byteplusAssetId === assetId || a?.id === assetId)
      : null;
    if (match?.imageUrl) {
      return referenceDisplayUrl(match.imageUrl, portraitAssets);
    }
    return url;
  }

  // 2. Strip hash fragment for <img> display
  let clean = url.split("#")[0];

  // 3. Strip any query parameter bp_asset_id that might have been saved in drafts
  if (clean.startsWith("http://") || clean.startsWith("https://")) {
    clean = clean
      .replace(/([?&])bp[-_]asset(?:_id)?=[^&#]+(&?)/, (match, prefix, suffix) => {
        if (prefix === "?" && suffix) return "?";
        return "";
      })
      .replace(/[?&]$/, "");
  }

  return clean;
}

/**
 * Force the same-origin form of a `/api/media/...` URL.
 *
 * The media route normally redirects to a CDN or signed cloud URL so the bytes
 * never touch the serverless function. That is right for display — `<img src>`
 * and `<video src>` do not care where the bytes come from — but three things in
 * this app read media *as data* and all of them are same-origin-only:
 *
 *  - `fetch(...).blob()` — a cross-origin fetch needs CORS headers on the
 *    bucket, and gets an opaque failure without them;
 *  - `extractFrame` draws a `<video>` into a canvas, which taints it
 *    cross-origin and makes `toDataURL` throw;
 *  - `<a download>` is ignored by browsers on a cross-origin href, so the
 *    button navigates instead of saving.
 *
 * Those are all user-initiated, one-at-a-time operations, so proxying them
 * costs nothing worth optimising — unlike the feed, which is what the redirect
 * exists for. Configuring bucket CORS would let the first two go direct too;
 * this keeps them working without depending on that.
 */

export function inlineMediaUrl(url) {
  if (!url) return undefined;
  if (!url.startsWith("/api/media/")) return url;
  return `${url}${url.includes("?") ? "&" : "?"}inline=1`;
}

export function timeAgo(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
