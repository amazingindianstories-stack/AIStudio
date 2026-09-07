// BytePlus Pro dimensions, verified 2026-09-07 against ModelArk/1824121.
import { parseAssetSlugs, parseMentionIndices, TAG_REGEX } from "./mentions";
export const SEEDREAM_SIZES = {
  "1K": { "1:1": "1024x1024", "4:3": "1152x864", "3:4": "864x1152", "16:9": "1424x800", "9:16": "800x1424", "21:9": "1568x672" },
  "2K": { "1:1": "2048x2048", "4:3": "2368x1776", "3:4": "1776x2368", "16:9": "2816x1584", "9:16": "1584x2816", "21:9": "3136x1344" },
};
export function seedreamSize(resolution = "2K", aspectRatio = "1:1") {
  const size = SEEDREAM_SIZES[resolution]?.[aspectRatio];
  if (!size) throw new Error("Seedream 5.0 Pro requires 1K or 2K and a supported aspect ratio.");
  return size;
}

// Pure resolution: fail before any paid call, never add Gemini identity tiles.
export function resolveSeedreamReferences(prompt, assets = [], uploads = []) {
  if (!Array.isArray(uploads) || uploads.some(x => typeof x !== "string" || !x)) throw new Error("Invalid reference images. Upload the images again.");
  const groups = [];
  for (const slug of parseAssetSlugs(prompt.replace(/@img\d+\b/gi, ""))) {
    const asset = assets.find(a => a.slug.toLowerCase() === slug);
    if (!asset?.images?.length) throw new Error(`Missing reference @${slug}. Attach the asset or remove its tag.`);
    groups.push({ tag: slug, refs: asset.images, role: `${asset.kind}: ${asset.name}${asset.description ? " — " + asset.description : ""}` });
  }
  const tagged = parseMentionIndices(prompt);
  if (/@img0(?![0-9])/i.test(prompt) || tagged.some(n => n > uploads.length)) throw new Error("A tagged image is missing. Attach it or correct the @img number.");
  for (const n of (tagged.length ? tagged : uploads.map((_, i) => i + 1))) {
    groups.push({ tag: `img${n}`, refs: [uploads[n - 1]], role: "use as instructed in the prompt" });
  }
  const references = []; const names = new Map(); const legend = [];
  for (const group of groups) {
    const images = group.refs.map(ref => { references.push(ref); return `image ${references.length}`; }).join(", ");
    names.set(group.tag, images);
    legend.push(`${images}: ${group.role}`);
  }
  if (references.length > 10) throw new Error(`Seedream 5.0 Pro accepts at most 10 resolved images; this prompt resolves to ${references.length}. Reduce uploads or named asset images.`);
  const rewritten = prompt.replace(/@img(\d+)\b/gi, (tag, n) => names.get(`img${Number(n)}`) ?? tag).replace(new RegExp(TAG_REGEX), (tag, slug) => names.get(slug.toLowerCase()) ?? tag);
  return { references, prompt: legend.length ? `References:\n${legend.join("\n")}\nFollow the user's editing instructions, including any requested changes to the references.\n\n${rewritten}` : rewritten };
}
