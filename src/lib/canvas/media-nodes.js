/**
 * Format v1 media objects: video, PDF, embed, link card, code block, emoji and icon, and the `link` any object
 * may carry. Mirrors backend/apps/canvas/media_nodes.py; the shared cases in
 * backend/apps/canvas/fixtures/format_v1_media.json hold the two to the same output.
 *
 * Media is always a reference to a stored file (`/api/media/...`), never a data URL or an address on another
 * site, which would leak each viewer's IP address. An embed is the one exception: its address must match a
 * provider rule in ./embeds.js.
 */
import { classifyEmbed } from "./embeds";

export const MEDIA_NODE_TYPES = ["audio", "video", "pdf", "embed", "linkcard", "code", "emoji", "icon"];
const MEDIA_PREFIX = "/api/media/";
const MAX_MEDIA_REF = 600;
const MAX_URL = 2048;
const MAX_CODE_UNITS = 20000;
const MAX_AGREED = 200;
const MAX_USER_ID = 64;
const NODE_ID_LIMIT = 64;

/** The code block's languages; `text` is plain text. Mirrors CODE_LANGUAGES in media_nodes.py. */
export const CODE_LANGUAGES = [
  "text",
  "javascript",
  "typescript",
  "python",
  "java",
  "c",
  "cpp",
  "csharp",
  "go",
  "rust",
  "php",
  "ruby",
  "swift",
  "kotlin",
  "sql",
  "yaml",
  "json",
  "html",
  "css",
  "bash",
  "mermaid",
];
const ICON_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const LINK_URL = /^https?:\/\/[^\x00-\x20\x7f]+$/;
const UUID = /^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

function finite(v) {
  return typeof v === "number" && Number.isFinite(v);
}

// Counted in code points on both sides, so a long title cuts at the same place as on the server.
function text(v, fallback, limit) {
  if (typeof v !== "string") return fallback;
  if (limit === undefined) return v;
  const points = Array.from(v);
  return points.length <= limit ? v : points.slice(0, limit).join("");
}

export function mediaRef(v) {
  return typeof v === "string" && v.startsWith(MEDIA_PREFIX) && v.length <= MAX_MEDIA_REF ? v : null;
}

/** An http(s) address for a link card or an object link; other schemes are never stored. */
export function linkUrl(v) {
  return typeof v === "string" && v.length <= MAX_URL && LINK_URL.test(v) ? v : null;
}

/**
 * An object's one link: `{ url }` to a website, `{ boardId }` to a board, or `{ nodeId }` (with an optional
 * `boardId`) to an object. Anything else is dropped.
 */
export function validateLink(raw) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const url = linkUrl(raw.url);
  if (url) return { url };
  const boardId = typeof raw.boardId === "string" && UUID.test(raw.boardId) ? raw.boardId : null;
  if (typeof raw.nodeId === "string" && raw.nodeId.length > 0 && raw.nodeId.length <= NODE_ID_LIMIT) {
    return { nodeId: raw.nodeId, ...(boardId ? { boardId } : {}) };
  }
  return boardId ? { boardId } : null;
}

function uniqueStrings(raw, limit, length) {
  const seen = new Set();
  for (const value of Array.isArray(raw) ? raw : []) {
    if (typeof value === "string" && value && !seen.has(value) && value.length <= length) {
      seen.add(value);
      if (seen.size === limit) break;
    }
  }
  return [...seen];
}

/** `base` plus the type's fields, or null when `r` is not valid for the type. */
export function validateMediaNode(type, r, base) {
  switch (type) {
    case "audio":
    case "video": {
      const src = mediaRef(r.src);
      if (!src) return null;
      const node = { ...base, type, src, aspectLocked: r.aspectLocked !== false, title: text(r.title, "", 200) };
      if (finite(r.naturalW)) node.naturalW = r.naturalW;
      if (finite(r.naturalH)) node.naturalH = r.naturalH;
      return node;
    }
    case "pdf": {
      const src = mediaRef(r.src);
      if (!src || !Number.isInteger(r.pages) || r.pages < 1 || r.pages > 2000) return null;
      const page = Number.isInteger(r.page) && r.page >= 1 && r.page <= r.pages ? r.page : 1;
      return { ...base, type, src, name: text(r.name, "Document", 200), pages: r.pages, page, aspectLocked: r.aspectLocked !== false };
    }
    case "embed": {
      const found = classifyEmbed(r.src);
      if (!found) return null;
      return { ...base, type, src: r.src, provider: found.provider, kind: found.kind, title: text(r.title, "", 200) };
    }
    case "linkcard": {
      const url = linkUrl(r.url);
      if (!url) return null;
      const node = {
        ...base,
        type,
        url,
        title: text(r.title, "", 300),
        description: text(r.description, "", 500),
        site: text(r.site, "", 120),
      };
      for (const key of ["image", "favicon"]) {
        const ref = mediaRef(r[key]);
        if (ref) node[key] = ref;
      }
      return node;
    }
    case "code": {
      return {
        ...base,
        type,
        code: text(r.code, "", MAX_CODE_UNITS),
        language: CODE_LANGUAGES.includes(r.language) ? r.language : "text",
        fontSize: finite(r.fontSize) ? Math.min(64, Math.max(8, r.fontSize)) : 14,
        lineNumbers: r.lineNumbers !== false,
      };
    }
    case "emoji": {
      if (typeof r.emoji !== "string" || r.emoji.length === 0 || r.emoji.length > 32) return null;
      const node = { ...base, type, emoji: r.emoji };
      if (finite(r.rotation)) node.rotation = ((r.rotation % 360) + 360) % 360;
      if (r.style === "sticker") node.style = "sticker";
      if (r.interactive === true) {
        node.interactive = true;
        const agreed = uniqueStrings(r.agreedBy, MAX_AGREED, MAX_USER_ID);
        if (agreed.length) node.agreedBy = agreed;
      }
      return node;
    }
    case "icon": {
      if (typeof r.icon !== "string" || !ICON_NAME.test(r.icon)) return null;
      return { ...base, type, icon: r.icon, color: text(r.color, "#e5e7eb", 32) };
    }
    default:
      return null;
  }
}
