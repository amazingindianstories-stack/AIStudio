/** Shared @imgN reference-tag logic (used by client UI and server routes). */

/** Match @img1, @IMG2, etc. (ad-hoc one-off uploads). */
export const MENTION_REGEX = /@img(\d+)/gi;

/** Match @vid1, @VID2 … — attached reference CLIPS (video-to-video).
 *  A separate namespace from @imgN because the two travel to the provider by
 *  completely different routes (inline base64 vs presigned URL). */
export const VIDEO_MENTION_REGEX = /@vid(\d+)/gi;
export const AUDIO_MENTION_REGEX = /@audio(\d+)/gi;

/** Match any @tag token: ad-hoc @imgN OR a named asset slug like @priya. */
export const TAG_REGEX = /@([a-z][a-z0-9_-]*)/gi;

/** True for ad-hoc upload tags (@img1, @img2 …) vs named asset slugs. */
export function isImgTag(slug) {
  return /^img\d+$/i.test(slug);
}

/** True for attached-audio tags (@audio1, @audio2 …). */
export function isAudioTag(slug) {
  return /^audio\d+$/i.test(slug);
}

/** True for attached-clip tags (@vid1, @vid2 …, or @video1 …). */
export function isVidTag(slug) {
  return /^(vid|video)\d+$/i.test(slug);
}

/** True for any ad-hoc/system tags (@imgN, @vidN, @videoN, @audioN). */
export function isReservedTag(slug) {
  return isImgTag(slug) || isVidTag(slug) || isAudioTag(slug) || /^image\d+$/i.test(slug);
}

export function isReservedSlug(slug) {
  return /^(img|image|vid|video|audio)\d+$/i.test(slug);
}

export function sanitizeSlug(name) {
  let base = (name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);

  if (!base) base = "asset";
  if (isReservedSlug(base)) {
    base = `asset-${base}`;
  }
  return base;
}

/**
 * Normalizes common informal/non-canonical media reference tokens in prompts
 * to their canonical equivalents (@imgN, @vidN, @audioN).
 *
 * Supported informal variants:
 * - @image1, @image 1, @image_1, @image-1, @img 1, @img_1, @img-1, @pic1, @pic 1 -> @imgN
 * - @video1, @video 1, @video_1, @video-1, @vid 1, @vid_1, @vid-1 -> @vidN
 * - @audio 1, @audio_1, @audio-1 -> @audioN
 */
export function normalizePromptMentions(prompt = "") {
  if (!prompt || typeof prompt !== "string") return prompt || "";
  let text = prompt;
  // Non-canonical image references -> @imgN
  text = text.replace(/@(image|pic)[\s_-]*(\d+)(?!\d)/gi, "@img$2");
  text = text.replace(/@img[\s_-]+(\d+)(?!\d)/gi, "@img$1");
  // Non-canonical video references -> @vidN
  text = text.replace(/@video[\s_-]*(\d+)(?!\d)/gi, "@vid$1");
  text = text.replace(/@vid[\s_-]+(\d+)(?!\d)/gi, "@vid$1");
  // Non-canonical audio references -> @audioN
  text = text.replace(/@audio[\s_-]+(\d+)(?!\d)/gi, "@audio$1");
  return text;
}

/** Regex matching informal/non-canonical tokens for a specific media type and 1-based index. */
export function getNonCanonicalTagRegex(type, n) {
  if (type === "img") {
    return new RegExp(`@(image|pic)[\\s_-]*${n}(?!\\d)|@img[\\s_-]+${n}(?!\\d)`, "gi");
  }
  if (type === "vid" || type === "video") {
    return new RegExp(`@video[\\s_-]*${n}(?!\\d)|@vid[\\s_-]+${n}(?!\\d)`, "gi");
  }
  if (type === "audio") {
    return new RegExp(`@audio[\\s_-]+${n}(?!\\d)`, "gi");
  }
  return null;
}

function getEditRange(prev = "", next = "") {
  let start = 0;
  while (start < prev.length && start < next.length && prev[start] === next[start]) {
    start++;
  }
  let prevEnd = prev.length;
  let nextEnd = next.length;
  while (prevEnd > start && nextEnd > start && prev[prevEnd - 1] === next[nextEnd - 1]) {
    prevEnd--;
    nextEnd--;
  }
  return {
    start,
    removed: prev.slice(start, prevEnd),
    added: next.slice(start, nextEnd),
  };
}

/**
 * Automatically synchronizes tag corrections across the prompt.
 * When a user corrects an appearance of a tag (e.g. changing @image 1 or @image1
 * to @img1), all other matching non-canonical occurrences across nextText are
 * updated to match, while accurately adjusting caretPos to avoid cursor jumping.
 */
export function syncMentionTagCorrection(
  prevText = "",
  nextText = "",
  caretPos = nextText?.length || 0
) {
  if (!nextText || typeof nextText !== "string") {
    return { text: nextText || "", caret: caretPos || 0, changed: false };
  }

  const safeCaret =
    typeof caretPos === "number"
      ? Math.max(0, Math.min(caretPos, nextText.length))
      : nextText.length;

  // 1. Scan nextText for canonical tags (@imgN, @vidN, @audioN)
  const CANONICAL_RE = /@(img|vid|audio)(\d+)/gi;
  const canonicalTags = [];
  let m;
  while ((m = CANONICAL_RE.exec(nextText)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    canonicalTags.push({
      kind: m[1].toLowerCase(),
      index: parseInt(m[2], 10),
      tag: `@${m[1].toLowerCase()}${m[2]}`,
      start,
      end,
      // Near caret allows user typing at or right after the tag (e.g. "@img1 ")
      isNearCaret: safeCaret >= start && safeCaret <= end + 1,
    });
  }

  // 2. Also check if the diff replaced an old tag with a different index or kind
  const edit = getEditRange(prevText || "", nextText);
  let oldTagReplaced = null;
  if (edit.removed) {
    const prevWindow = (prevText || "").slice(
      Math.max(0, edit.start - 10),
      edit.start + edit.removed.length + 5
    );
    const oldMatch = prevWindow.match(/@(image|img|pic|video|vid|audio)[\s_-]*(\d+)/i);
    if (oldMatch) {
      const type =
        oldMatch[1].toLowerCase().startsWith("vid") || oldMatch[1].toLowerCase().startsWith("video")
          ? "vid"
          : oldMatch[1].toLowerCase().startsWith("audio")
          ? "audio"
          : "img";
      oldTagReplaced = {
        type,
        index: parseInt(oldMatch[2], 10),
      };
    }
  }

  // 3. Collect targets to synchronize
  const syncTargets = [];
  const nearCaret = canonicalTags.filter((t) => t.isNearCaret);
  const candidates = nearCaret.length ? nearCaret : canonicalTags;

  for (const c of candidates) {
    if (oldTagReplaced && oldTagReplaced.type === c.kind && oldTagReplaced.index !== c.index) {
      syncTargets.push({
        type: c.kind,
        targetIndex: oldTagReplaced.index,
        replacement: c.tag,
        sourceStart: c.start,
        sourceEnd: c.end,
      });
    }
    syncTargets.push({
      type: c.kind,
      targetIndex: c.index,
      replacement: c.tag,
      sourceStart: c.start,
      sourceEnd: c.end,
    });
  }

  if (!syncTargets.length) {
    return { text: nextText, caret: safeCaret, changed: false };
  }

  let text = nextText;
  let newCaret = safeCaret;
  let changed = false;

  for (const target of syncTargets) {
    const regex = getNonCanonicalTagRegex(target.type, target.targetIndex);
    if (!regex) continue;

    const matches = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
      matches.push({
        start: match.index,
        end: match.index + match[0].length,
        raw: match[0],
      });
    }

    if (!matches.length) continue;

    // Apply replacements from right to left to keep preceding offsets valid
    for (let i = matches.length - 1; i >= 0; i--) {
      const item = matches[i];
      const before = text.slice(0, item.start);
      const after = text.slice(item.end);
      text = before + target.replacement + after;
      changed = true;

      const diff = target.replacement.length - item.raw.length;
      if (item.start < newCaret) {
        if (newCaret >= item.end) {
          newCaret += diff;
        } else {
          newCaret = item.start + target.replacement.length;
        }
      }
    }
  }

  return {
    text,
    caret: Math.max(0, Math.min(newCaret, text.length)),
    changed,
  };
}

/**
 * Named asset slugs referenced in a prompt (e.g. @sati, @scene1, @priya), in
 * first-appearance order, excluding ad-hoc tokens.
 */
export function parseAssetSlugs(prompt) {
  const seen = new Set();
  const order = [];
  const normalized = normalizePromptMentions(prompt);
  const re = new RegExp(TAG_REGEX);
  let m;
  while ((m = re.exec(normalized))) {
    const slug = m[1].toLowerCase();
    if (isReservedTag(slug) || seen.has(slug)) continue;
    seen.add(slug);
    order.push(slug);
  }
  return order;
}

/** Unique 1-based indices referenced by @imgN tokens, in ascending order. */
export function parseMentionIndices(prompt) {
  const set = new Set();
  const normalized = normalizePromptMentions(prompt);
  const re = new RegExp(MENTION_REGEX);
  let m;
  while ((m = re.exec(normalized))) {
    const n = parseInt(m[1], 10);
    if (n >= 1) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

/** Unique 1-based indices referenced by @vidN tokens, ascending. */
export function parseVideoMentionIndices(prompt) {
  const set = new Set();
  const normalized = normalizePromptMentions(prompt);
  const re = new RegExp(VIDEO_MENTION_REGEX);
  let m;
  while ((m = re.exec(normalized))) {
    const n = parseInt(m[1], 10);
    if (n >= 1) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

export function parseAudioMentionIndices(prompt) {
  const set = new Set();
  const normalized = normalizePromptMentions(prompt);
  const re = new RegExp(AUDIO_MENTION_REGEX);
  let m;
  while ((m = re.exec(normalized))) {
    const n = parseInt(m[1], 10);
    if (n >= 1) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

export function resolveAudioReferences(prompt, audio) {
  if (!audio?.length) return [];
  const tagged = parseAudioMentionIndices(prompt).filter((n) => n <= audio.length);
  const indices = tagged.length ? tagged : audio.map((_, i) => i + 1);
  return indices.map((n) => audio[n - 1]);
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

/**
 * Resolves all references from both the Material Library (@sati, @scene1)
 * and ad-hoc attachments (@imgN, @vidN, @audioN).
 */
export function resolveAllReferences(
  prompt = "",
  assets = [],
  uploads = [],
  clips = [],
  audios = []
) {
  const bySlug = new Map(assets.map((a) => [a.slug.toLowerCase(), a]));
  const slugs = parseAssetSlugs(prompt);
  const materials = [];
  for (const slug of slugs) {
    const asset = bySlug.get(slug);
    if (asset && asset.images?.length) {
      materials.push({
        tag: `@${asset.slug}`,
        slug: asset.slug,
        asset,
        image: asset.images[0],
      });
    }
  }

  const images = resolveReferences(prompt, uploads);
  const videos = resolveVideoReferences(prompt, clips);
  const audio = resolveAudioReferences(prompt, audios);

  return {
    materials,
    images,
    videos,
    audio,
  };
}
