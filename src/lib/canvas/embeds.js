/**
 * Board embeds: a closed list of providers whose embed pages may be framed on a board. Mirrors
 * backend/apps/canvas/embeds.py, which enforces the same rules on save: a pasted link or iframe code becomes
 * the provider's own embed address, and only such an address is ever framed (sandboxed, see EmbedNode).
 */

export const MAX_EMBED_SRC = 1024;
const YOUTUBE_ID = "[A-Za-z0-9_-]{11}";
const SPOTIFY_KINDS = "track|album|playlist|episode|show|artist";

// [provider, kind, host, path, needs a query]; patterns match in full.
const RULES = [
  ["youtube", "video", /^(?:www\.youtube\.com|www\.youtube-nocookie\.com)$/, new RegExp(`^/embed/${YOUTUBE_ID}$`), false],
  ["vimeo", "video", /^player\.vimeo\.com$/, /^\/video\/[0-9]{1,12}$/, false],
  ["loom", "video", /^www\.loom\.com$/, /^\/embed\/[0-9a-f]{32}$/, false],
  ["dailymotion", "video", /^www\.dailymotion\.com$/, /^\/embed\/video\/[A-Za-z0-9]{3,16}$/, false],
  ["spotify", "audio", /^open\.spotify\.com$/, new RegExp(`^/embed/(?:${SPOTIFY_KINDS})/[A-Za-z0-9]{10,40}$`), false],
  ["soundcloud", "audio", /^w\.soundcloud\.com$/, /^\/player\/?$/, true],
  ["figma", "other", /^www\.figma\.com$/, /^\/embed$/, true],
  ["drive", "other", /^drive\.google\.com$/, /^\/file\/d\/[A-Za-z0-9_-]{10,80}\/preview$/, false],
];

export const PROVIDER_NAMES = {
  youtube: "YouTube",
  vimeo: "Vimeo",
  loom: "Loom",
  dailymotion: "Dailymotion",
  spotify: "Spotify",
  soundcloud: "SoundCloud",
  figma: "Figma",
  drive: "Google Drive",
};

const HTTPS_URL = /^https:\/\/[^\x00-\x20\x7f"'<>\\]+$/;

function split(src) {
  let url;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || (url.port && url.port !== "443") || url.hash) {
    return null;
  }
  return url;
}

/** `{ provider, kind }` when `src` is a framable provider embed address, else null. */
export function classifyEmbed(src) {
  if (typeof src !== "string" || src.length === 0 || src.length > MAX_EMBED_SRC || !HTTPS_URL.test(src)) return null;
  const url = split(src);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  for (const [provider, kind, hostPattern, pathPattern, needsQuery] of RULES) {
    if (hostPattern.test(host) && pathPattern.test(url.pathname)) {
      if (needsQuery && !url.search) continue;
      return { provider, kind };
    }
  }
  return null;
}

export function isAllowedEmbedSrc(src) {
  return classifyEmbed(src) !== null;
}

function result(src) {
  const info = classifyEmbed(src);
  return info ? { ...info, src, title: PROVIDER_NAMES[info.provider] } : null;
}

/** The embed for a page link or an embed address, or null when no provider matches. */
export function embedFromUrl(input) {
  if (typeof input !== "string") return null;
  const text = input.trim();
  const direct = result(text);
  if (direct) return direct;
  if (!HTTPS_URL.test(text) || text.length > 2048) return null;
  const url = split(text);
  if (!url) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname;
  const query = (key) => url.searchParams.get(key) ?? "";
  let match;
  let found = null;
  if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
    match = new RegExp(`^/(?:shorts|live|embed)/(${YOUTUBE_ID})$`).exec(path);
    found = match ? match[1] : query("v") || null;
  } else if (host === "youtu.be") {
    match = new RegExp(`^/(${YOUTUBE_ID})$`).exec(path);
    found = match ? match[1] : null;
  }
  if (found !== null) {
    if (!new RegExp(`^${YOUTUBE_ID}$`).test(found)) return null;
    const start = query("t") || query("start");
    const suffix = start && /^[0-9]{1,6}s?$/.test(start) ? `?start=${parseInt(start, 10)}` : "";
    return result(`https://www.youtube.com/embed/${found}${suffix}`);
  }
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const hashed = /^\/([0-9]{1,12})\/([0-9a-f]{6,20})$/.exec(path);
    match = hashed ?? /^\/(?:video\/)?(?:channels\/[a-z0-9_-]+\/|groups\/[a-z0-9_-]+\/videos\/)?([0-9]{1,12})$/.exec(path);
    if (!match) return null;
    const hash = hashed ? hashed[2] : query("h");
    return result(`https://player.vimeo.com/video/${match[1]}${/^[0-9a-f]{6,20}$/.test(hash) ? `?h=${hash}` : ""}`);
  }
  if (host === "loom.com") {
    match = /^\/(?:share|embed)\/([0-9a-f]{32})$/.exec(path);
    return match ? result(`https://www.loom.com/embed/${match[1]}`) : null;
  }
  if (host === "dailymotion.com" || host === "dai.ly") {
    match = /^\/(?:video\/)?([A-Za-z0-9]{3,16})$/.exec(path);
    return match ? result(`https://www.dailymotion.com/embed/video/${match[1]}`) : null;
  }
  if (host === "open.spotify.com") {
    match = new RegExp(`^/(?:intl-[a-z]{2,5}/)?(?:embed/)?(${SPOTIFY_KINDS})/([A-Za-z0-9]{10,40})$`).exec(path);
    return match ? result(`https://open.spotify.com/embed/${match[1]}/${match[2]}`) : null;
  }
  if (host === "soundcloud.com" && /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+){0,2}$/.test(path)) {
    return result(`https://w.soundcloud.com/player/?url=${encodeURIComponent(`https://soundcloud.com${path}`)}`);
  }
  if (host === "figma.com" && /^\/(?:file|design|proto|board|slides)\/[A-Za-z0-9]+(?:\/.*)?$/.test(path)) {
    return result(`https://www.figma.com/embed?embed_host=veevee&url=${encodeURIComponent(text)}`);
  }
  if (host === "drive.google.com") {
    match = /^\/file\/d\/([A-Za-z0-9_-]{10,80})(?:\/.*)?$/.exec(path);
    return match ? result(`https://drive.google.com/file/d/${match[1]}/preview`) : null;
  }
  return null;
}

const MAX_CODE = 4000;

function unescapeHtml(text) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * The embed for pasted iframe code. Only the frame's `src` is read; sizes, scripts and other markup in the
 * pasted code are dropped, and the address must itself be a provider embed address.
 */
export function embedFromIframe(code) {
  if (typeof code !== "string" || code.length > MAX_CODE) return null;
  const tag = /<iframe\b([^>]*)>/i.exec(code);
  if (!tag) return null;
  const attributes = {};
  for (const [, name, double, single] of tag[1].matchAll(/([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const key = name.toLowerCase();
    if (!(key in attributes)) attributes[key] = double || single || "";
  }
  let src = unescapeHtml(attributes.src ?? "").trim();
  if (src.startsWith("//")) src = `https:${src}`;
  const found = result(src);
  if (!found) return null;
  const title = unescapeHtml(attributes.title ?? "").trim();
  if (title) found.title = title.slice(0, 200);
  return found;
}
