/** Shared @imgN reference-tag logic (used by client UI and server routes). */

/** Match @img1, @IMG2, etc. (ad-hoc one-off uploads). */
export const MENTION_REGEX = /@img(\d+)/gi;

/** Match @vid1, @VID2 … — attached reference CLIPS (video-to-video).
 *  A separate namespace from @imgN because the two travel to the provider by
 *  completely different routes (inline base64 vs presigned URL). */
export const VIDEO_MENTION_REGEX = /@vid(\d+)/gi;

/** Match any @tag token: ad-hoc @imgN OR a named asset slug like @priya. */
export const TAG_REGEX = /@([a-z][a-z0-9_-]*)/gi;

/** True for ad-hoc upload tags (@img1, @img2 …) vs named asset slugs. */
export function isImgTag(slug) {
  return /^img\d+$/i.test(slug);
}

/** True for attached-clip tags (@vid1, @vid2 …). */
export function isVidTag(slug) {
  return /^vid\d+$/i.test(slug);
}

/**
 * Named asset slugs referenced in a prompt (e.g. @priya, @red-lehenga), in
 * first-appearance order, excluding the ad-hoc @imgN tokens.
 */
export function parseAssetSlugs(prompt) {
  const seen = new Set();
  const order = [];
  const re = new RegExp(TAG_REGEX);
  let m;
  while ((m = re.exec(prompt))) {
    const slug = m[1].toLowerCase();
    // @vidN is a clip tag, not an asset slug. Without this it was looked up as
    // a saved asset named "vid1", found nothing, and silently stayed in the
    // prompt as ordinary text — which is why typing @vid1 appeared to do
    // nothing at all.
    if (isImgTag(slug) || isVidTag(slug) || seen.has(slug)) continue;
    seen.add(slug);
    order.push(slug);
  }
  return order;
}

/** Unique 1-based indices referenced by @imgN tokens, in ascending order. */
export function parseMentionIndices(prompt) {
  const set = new Set();
  const re = new RegExp(MENTION_REGEX);
  let m;
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
/** Unique 1-based indices referenced by @vidN tokens, ascending. */
export function parseVideoMentionIndices(prompt) {
  const set = new Set();
  const re = new RegExp(VIDEO_MENTION_REGEX);
  let m;
  while ((m = re.exec(prompt))) {
    const n = parseInt(m[1], 10);
    if (n >= 1) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * Which attached clips to actually send, mirroring resolveReferences: an
 * explicit @vidN tag is intent, no tags means send them all.
 */
export function resolveVideoReferences(
  prompt,
  clips
) {
  if (!clips?.length) return [];
  const tagged = parseVideoMentionIndices(prompt).filter((n) => n <= clips.length);
  const indices = tagged.length ? tagged : clips.map((_, i) => i + 1);
  return indices.map((n) => clips[n - 1]);
}

export function resolveReferences(
  prompt,
  uploads
) {
  if (!uploads?.length) return [];
  const tagged = parseMentionIndices(prompt).filter((n) => n <= uploads.length);
  const indices = tagged.length ? tagged : uploads.map((_, i) => i + 1);
  return indices.map((n) => ({
    tag: `@img${n}`,
    index: n,
    dataUrl: uploads[n - 1],
  }));
}

/**
 * Rewrites @imgN tokens so they keep pointing at the same physical image
 * after the upload array is reordered. @imgN is a live index into whatever
 * `referenceImages` currently holds (see resolveReferences) rather than a
 * stored id, so reordering the array without this would silently repoint an
 * already-typed tag at a different image.
 *
 * `mapping[oldIndex]` (0-based) is the image's new 0-based index; an old
 * index missing from `mapping` (out of range) is left untouched, matching
 * resolveReferences' "out-of-range tags ignored" behavior.
 *
 * Safe for swaps (e.g. @img1 <-> @img2): String.replace with a global regex
 * resolves every match against the *original* string before substituting, so
 * an already-replaced token is never re-matched.
 */
export function renumberImgMentions(prompt, mapping) {
  const re = new RegExp(MENTION_REGEX);
  return prompt.replace(re, (match, digits) => {
    const oldIndex = parseInt(digits, 10) - 1;
    const newIndex = mapping[oldIndex];
    return newIndex === undefined ? match : `@img${newIndex + 1}`;
  });
}
