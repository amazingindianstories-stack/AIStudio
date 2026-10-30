/**
 * Emoji reactions on stickies: `reactions: {emoji: [userId, ...]}`, where each
 * person votes on an emoji at most once. Mirrored by `reactions` in
 * backend/apps/canvas/serialization.py. A vote is not an edit: it keeps the
 * sticky's stamps and History (backend/apps/canvas/activity.py), and when two
 * people vote on one sticky at once both votes survive the merge
 * (`mergeReactions`).
 */
export const MAX_REACTION_EMOJIS = 12;
export const MAX_REACTION_EMOJI = 16;
export const MAX_REACTION_VOTES = 1000;
const MAX_VOTER_ID = 64;
const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/;

/** The emojis offered in the reaction picker. */
export const REACTION_EMOJIS = ["👍", "👎", "❤️", "😂", "🎉", "🔥", "👀", "✅", "❌", "❓", "💡", "⭐"];

/** Up to `limit` distinct non-empty strings of at most `length` UTF-16 units. */
export function uniqueStrings(raw, limit, length = Infinity) {
  const result = [];
  if (!Array.isArray(raw)) return result;
  for (const value of raw) {
    if (typeof value === "string" && value && value.length <= length && !result.includes(value)) {
      result.push(value);
      if (result.length === limit) break;
    }
  }
  return result;
}

export function validateReactions(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const result = {};
  let count = 0;
  for (const [emoji, voters] of Object.entries(raw)) {
    if (count === MAX_REACTION_EMOJIS) break;
    // An array-index key would change places in a JavaScript object.
    if (!emoji || emoji.length > MAX_REACTION_EMOJI || ARRAY_INDEX.test(emoji)) continue;
    const valid = uniqueStrings(voters, MAX_REACTION_VOTES, MAX_VOTER_ID);
    if (valid.length) {
      result[emoji] = valid;
      count += 1;
    }
  }
  return count ? result : null;
}

/** `node` with `userId`'s vote on `emoji` added, or removed when it was there. */
export function toggleReaction(node, emoji, userId) {
  const reactions = { ...(node.reactions ?? {}) };
  const voters = reactions[emoji] ?? [];
  if (voters.includes(userId)) {
    const rest = voters.filter((id) => id !== userId);
    if (rest.length) reactions[emoji] = rest;
    else delete reactions[emoji];
  } else {
    if (!(emoji in reactions) && Object.keys(reactions).length >= MAX_REACTION_EMOJIS) return node;
    if (voters.length >= MAX_REACTION_VOTES) return node;
    reactions[emoji] = [...voters, userId];
  }
  const next = { ...node };
  if (Object.keys(reactions).length) next.reactions = reactions;
  else delete next.reactions;
  return next;
}

/**
 * Three-way merge of one sticky's reactions: everyone only adds or removes
 * their own vote, so each (emoji, person) pair takes whichever side changed
 * it, and concurrent votes from different people all survive.
 */
export function mergeReactions(base, local, remote) {
  const b = base ?? {};
  const l = local ?? {};
  const r = remote ?? {};
  const result = {};
  for (const emoji of new Set([...Object.keys(r), ...Object.keys(l)])) {
    const inBase = new Set(b[emoji] ?? []);
    const inLocal = new Set(l[emoji] ?? []);
    const voters = (r[emoji] ?? []).filter((id) => !(inBase.has(id) && !inLocal.has(id)));
    for (const id of l[emoji] ?? []) if (!inBase.has(id) && !voters.includes(id)) voters.push(id);
    if (voters.length) result[emoji] = voters;
  }
  return Object.keys(result).length ? result : undefined;
}
