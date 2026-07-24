import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function aspectToPadding(ratio: string): string {
  const [w, h] = ratio.split(":").map(Number);
  if (!w || !h) return "56.25%";
  return `${(h / w) * 100}%`;
}

/** Append a `?w=` resize hint to a `/api/media/...` URL for grid/canvas
 * thumbnails — the media route resizes+re-encodes images on read (see
 * route.ts). Leaves non-media URLs (e.g. data: URLs, external URLs)
 * untouched since only our own proxy understands the param. */
export function thumbUrl(url: string | undefined | null, width: number): string | undefined {
  if (!url) return undefined;
  if (!url.startsWith("/api/media/")) return url;
  return `${url}${url.includes("?") ? "&" : "?"}w=${width}`;
}

export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
