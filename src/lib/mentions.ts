/** Shared @imgN reference-tag logic (used by client UI and server routes). */

export interface LabeledRef {
  tag: string; // "@img1"
  index: number; // 1-based
  dataUrl: string; // data:image/...;base64,...
}

/** Match @img1, @IMG2, etc. (ad-hoc one-off uploads). */
export const MENTION_REGEX = /@img(\d+)/gi;

/** Match any @tag token: ad-hoc @imgN OR a named asset slug like @priya. */
export const TAG_REGEX = /@([a-z][a-z0-9_-]*)/gi;

/** True for ad-hoc upload tags (@img1, @img2 …) vs named asset slugs. */
export function isImgTag(slug: string): boolean {
  return /^img\d+$/i.test(slug);
}

/**
 * Named asset slugs referenced in a prompt (e.g. @priya, @red-lehenga), in
 * first-appearance order, excluding the ad-hoc @imgN tokens.
 */
export function parseAssetSlugs(prompt: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const re = new RegExp(TAG_REGEX);
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt))) {
    const slug = m[1].toLowerCase();
    if (isImgTag(slug) || seen.has(slug)) continue;
    seen.add(slug);
    order.push(slug);
  }
  return order;
}

/** Unique 1-based indices referenced by @imgN tokens, in ascending order. */
export function parseMentionIndices(prompt: string): number[] {
  const set = new Set<number>();
  const re = new RegExp(MENTION_REGEX);
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt))) {
    const n = parseInt(m[1], 10);
    if (n >= 1) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Decide which uploaded images to actually send to the model.
 * - If the prompt tags images (@img1 …), send only those (the tag = intent).
 * - If the prompt tags none, fall back to sending all uploads.
 * Out-of-range tags (e.g. @img9 with 2 uploads) are ignored.
 */
export function resolveReferences(
  prompt: string,
  uploads: string[]
): LabeledRef[] {
  if (!uploads?.length) return [];
  const tagged = parseMentionIndices(prompt).filter((n) => n <= uploads.length);
  const indices = tagged.length ? tagged : uploads.map((_, i) => i + 1);
  return indices.map((n) => ({
    tag: `@img${n}`,
    index: n,
    dataUrl: uploads[n - 1],
  }));
}
