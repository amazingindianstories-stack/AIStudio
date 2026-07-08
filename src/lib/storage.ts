import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Local file storage. Generated media + reference/asset images
 * are saved to public/media so they can be served by Next.js.
 */
export const MEDIA_BUCKET = "media";
const MEDIA_DIR = path.join(process.cwd(), "public", MEDIA_BUCKET);

function extToMime(ext: string): string {
  const e = ext.toLowerCase();
  if (e === "jpg" || e === "jpeg") return "image/jpeg";
  if (e === "mp4") return "video/mp4";
  if (e === "webp") return "image/webp";
  return `image/${e || "png"}`;
}

/** Upload raw bytes; returns the public URL. */
export async function uploadBuffer(
  buffer: Buffer,
  key: string,
  ext: string
): Promise<string> {
  const filePath = path.join(MEDIA_DIR, key);
  // Keys are namespaced (generations/…, references/…) — create the subdir too.
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, buffer);
  return `/${MEDIA_BUCKET}/${key}`;
}

/** Upload a base64 payload; returns the public URL. */
export async function uploadBase64(
  base64: string,
  key: string,
  ext: string
): Promise<string> {
  return uploadBuffer(Buffer.from(base64, "base64"), key, ext);
}

/** Split a data URL into ext + base64. */
export function splitDataUrl(input: string): { ext: string; data: string } {
  const m = input.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.*)$/s);
  if (m) {
    const ext = m[1] === "jpeg" ? "jpg" : m[1].toLowerCase();
    return { ext, data: m[2] };
  }
  return { ext: "png", data: input };
}

/** Download a remote URL (e.g. a provider video) and store it; returns URL. */
export async function uploadFromUrl(
  url: string,
  key: string,
  ext: string
): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download media (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  return uploadBuffer(buf, key, ext);
}

/** Read a stored object (public URL or path) back as base64 + mime. */
export async function readAsBase64(
  ref: string
): Promise<{ mimeType: string; data: string }> {
  if (ref.startsWith("data:")) {
    const m = ref.match(/^data:([^;]+);base64,(.*)$/s);
    if (m) return { mimeType: m[1], data: m[2] };
    return { mimeType: "image/png", data: ref };
  }

  if (ref.startsWith(`/${MEDIA_BUCKET}/`)) {
    const key = ref.slice(`/${MEDIA_BUCKET}/`.length);
    const filePath = path.join(MEDIA_DIR, key);
    const buf = await fs.readFile(filePath);
    const ext = path.extname(key).slice(1);
    return { mimeType: extToMime(ext), data: buf.toString("base64") };
  }

  const res = await fetch(ref);
  if (!res.ok) throw new Error(`Failed to read media (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mimeType = res.headers.get("content-type") || "image/png";
  return { mimeType, data: buf.toString("base64") };
}

/** Delete objects by their public URL or storage key. Best-effort. */
export async function deleteByUrls(urls: string[]): Promise<void> {
  const prefix = `/${MEDIA_BUCKET}/`;
  for (const u of urls) {
    let key = null;
    if (u.startsWith(prefix)) {
      key = u.slice(prefix.length);
    } else {
      // it might be just the key itself
      if (!u.includes("/") && !u.startsWith("http")) key = u;
    }
    
    if (key) {
      try {
        await fs.unlink(path.join(MEDIA_DIR, key));
      } catch (err) {
        // Ignore if file not found
      }
    }
  }
}

/** Ensure the public media bucket exists (idempotent — used by seed). */
export async function ensureBucket(): Promise<void> {
  try {
    await fs.mkdir(MEDIA_DIR, { recursive: true });
  } catch (err) {
    // Ignore if exists
  }
}
