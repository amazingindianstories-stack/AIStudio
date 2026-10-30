/**
 * Board tags: one table per board (`state.tags`, `[{id, name, color}]`) and
 * up to eight tag ids per sticky (`tagIds`). Renaming or recoloring a tag
 * changes only the table, so it is one small change for everyone and no
 * sticky counts as edited. Deleting one also takes it off its stickies, and
 * the serializers drop any id the table no longer has.
 * Mirrored by `tags` in backend/apps/canvas/serialization.py.
 */
export const MAX_TAGS = 300;
export const MAX_TAG_NAME = 60;
export const MAX_TAG_ID = 64;
export const MAX_NODE_TAGS = 8;
const DEFAULT_TAG_COLOR = "#9ca3af";
const HEX = /^#[0-9a-fA-F]{6}$/;

/** The colors the tag picker cycles through for new tags. */
export const TAG_COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#3b82f6", "#8b5cf6", "#ec4899", "#9ca3af"];

export function validateTags(raw) {
  const result = [];
  if (!Array.isArray(raw)) return result;
  const seen = new Set();
  for (const item of raw) {
    if (result.length === MAX_TAGS) break;
    if (item === null || typeof item !== "object") continue;
    const { id, name, color } = item;
    if (typeof id !== "string" || !id || id.length > MAX_TAG_ID || seen.has(id)) continue;
    if (typeof name !== "string" || !name.trim() || name.length > MAX_TAG_NAME) continue;
    seen.add(id);
    result.push({ id, name, color: typeof color === "string" && HEX.test(color) ? color : DEFAULT_TAG_COLOR });
  }
  return result;
}

/** Tag names compare without case or surrounding space, like Miro's picker. */
export function tagKey(name) {
  return name.trim().toLocaleLowerCase();
}

export function findTagByName(tags, name) {
  const key = tagKey(name);
  return tags.find((tag) => tagKey(tag.name) === key) ?? null;
}

/** `state` with a new tag named `name` (trimmed), and that tag; an existing name returns its tag. */
export function addTag(state, name, id = crypto.randomUUID()) {
  const tags = state.tags ?? [];
  const trimmed = name.trim().slice(0, MAX_TAG_NAME);
  if (!trimmed) return { state, tag: null };
  const existing = findTagByName(tags, trimmed);
  if (existing) return { state, tag: existing };
  if (tags.length >= MAX_TAGS) return { state, tag: null };
  const tag = { id, name: trimmed, color: TAG_COLORS[tags.length % TAG_COLORS.length] };
  return { state: { ...state, tags: [...tags, tag] }, tag };
}

/** `state` with tag `id` renamed or recolored; a blank name or one another tag has is refused. */
export function updateTag(state, id, changes) {
  const tags = state.tags ?? [];
  const next = {};
  if (changes.name !== undefined) {
    const trimmed = changes.name.trim().slice(0, MAX_TAG_NAME);
    const clash = findTagByName(tags, trimmed);
    if (!trimmed || (clash && clash.id !== id)) return state;
    next.name = trimmed;
  }
  if (changes.color !== undefined && HEX.test(changes.color)) next.color = changes.color;
  let changed = false;
  const updated = tags.map((tag) => {
    if (tag.id !== id) return tag;
    const merged = { ...tag, ...next };
    if (merged.name === tag.name && merged.color === tag.color) return tag;
    changed = true;
    return merged;
  });
  return changed ? { ...state, tags: updated } : state;
}

/** `state` without tag `id`, on the board and on every sticky. */
export function deleteTag(state, id) {
  const tags = (state.tags ?? []).filter((tag) => tag.id !== id);
  if (tags.length === (state.tags ?? []).length) return state;
  const nodes = state.nodes.map((node) => (node.tagIds?.includes(id) ? withTagIds(node, node.tagIds.filter((tagId) => tagId !== id)) : node));
  const next = { ...state, nodes };
  if (tags.length) next.tags = tags;
  else delete next.tags;
  return next;
}

export function withTagIds(node, tagIds) {
  const next = { ...node };
  if (tagIds.length) next.tagIds = tagIds.slice(0, MAX_NODE_TAGS);
  else delete next.tagIds;
  return next;
}

/**
 * `state` with tag `id` on every sticky in `ids` when `on`, otherwise off them.
 * A sticky that already has eight tags is left as it is.
 */
export function setTagOn(state, ids, id, on) {
  const targets = new Set(ids);
  let changed = false;
  const nodes = state.nodes.map((node) => {
    if (!targets.has(node.id) || node.type !== "sticky") return node;
    const current = node.tagIds ?? [];
    if (on === current.includes(id)) return node;
    if (on && current.length >= MAX_NODE_TAGS) return node;
    changed = true;
    return withTagIds(node, on ? [...current, id] : current.filter((tagId) => tagId !== id));
  });
  return changed ? { ...state, nodes } : state;
}

/** The tags on `node`, in the node's order, skipping ids the table lacks. */
export function tagsOf(node, tags) {
  if (!node.tagIds?.length) return [];
  const byId = new Map((tags ?? []).map((tag) => [tag.id, tag]));
  return node.tagIds.map((id) => byId.get(id)).filter(Boolean);
}

/** The tags whose names contain `query` (case-insensitive), best (prefix) matches first. */
export function searchTags(tags, query) {
  const key = tagKey(query);
  if (!key) return [...tags];
  const prefix = [];
  const rest = [];
  for (const tag of tags) {
    const name = tagKey(tag.name);
    if (name.startsWith(key)) prefix.push(tag);
    else if (name.includes(key)) rest.push(tag);
  }
  return [...prefix, ...rest];
}

/** The ids of the nodes that carry tag `id`, from the whole board (not the mounted DOM). */
export function nodesWithTag(state, id) {
  return state.nodes.filter((node) => node.tagIds?.includes(id)).map((node) => node.id);
}
