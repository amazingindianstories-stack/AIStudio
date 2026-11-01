/**
 * Board comments, pure parts: the mention token format, threads, where a pin sits, unread state and the
 * drafts kept in the browser. The server (backend/apps/canvas/comments.py) owns the data and the checks.
 */

export const COMMENT_EMOJIS = ["👍", "👎", "❤️", "🎉", "😄", "😮", "😢", "👀", "🔥", "✅", "❓", "🙏"];
export const COMMENT_COLORS = ["#f59e0b", "#ef4444", "#22c55e", "#3b82f6", "#a855f7", "#ec4899", "#14b8a6", "#94a3b8"];
export const MAX_COMMENT_LENGTH = 4000;
export const GROUP_MENTIONS = [
  { target: "board", label: "board", hint: "Everyone who has worked on this board" },
  { target: "team", label: "team", hint: "Everyone on the workspace" },
  { target: "space", label: "space", hint: "Everyone in this project" },
];

const TOKEN = /@\[([^\]\n]{1,80})\]\((user:[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}|board|team|space)\)/g;

/** The text a mention is stored as: `@[Name](user:<id>)`, or `@[board](board)` for a group. */
export function mentionToken(label, target) {
  return `@[${String(label).replace(/[\]\n]/g, " ").trim().slice(0, 80) || "someone"}](${target})`;
}

/** The body split into plain text and mention parts, for rendering chips. */
export function bodyParts(body) {
  const parts = [];
  let last = 0;
  for (const match of String(body ?? "").matchAll(TOKEN)) {
    if (match.index > last) parts.push({ type: "text", text: body.slice(last, match.index) });
    parts.push({ type: "mention", label: match[1], target: match[2], userId: match[2].startsWith("user:") ? match[2].slice(5).toLowerCase() : null });
    last = match.index + match[0].length;
  }
  if (last < body.length) parts.push({ type: "text", text: body.slice(last) });
  return parts;
}

/** The body as plain text, mentions shown as @Name. */
export function plainBody(body) {
  return bodyParts(body).map((part) => (part.type === "mention" ? `@${part.label}` : part.text)).join("");
}

/** The `@query` being typed right before the caret, or null: its start index and the text after the @. */
export function mentionQueryAt(text, caret) {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([^\s@\[\]]{0,30})$/.exec(before);
  return match ? { start: caret - match[2].length - 1, query: match[2] } : null;
}

/** The text with the @query before the caret replaced by `token` and a space, and where the caret goes. */
export function insertMention(text, caret, query, token) {
  const head = text.slice(0, query.start) + token + " ";
  return { text: head + text.slice(caret), caret: head.length };
}

/** Roots oldest first, each with its replies oldest first; deleted comments are dropped. */
export function threadsOf(comments) {
  const live = [...comments].filter((comment) => !comment.deleted).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  const replies = new Map();
  for (const comment of live) {
    if (comment.parentId) replies.set(comment.parentId, [...(replies.get(comment.parentId) ?? []), comment]);
  }
  return live.filter((comment) => !comment.parentId).map((root) => ({ root, replies: replies.get(root.id) ?? [] }));
}

/** Fold polled comments into the known ones by id, newest `updatedAt` winning; deleted ones are removed. */
export function mergeComments(known, incoming) {
  const next = new Map(known);
  for (const comment of incoming) {
    const current = next.get(comment.id);
    if (current && current.updatedAt > comment.updatedAt) continue;
    if (comment.deleted) next.delete(comment.id);
    else next.set(comment.id, comment);
  }
  return next;
}

/** The newest `updatedAt` seen, the next poll's `since`. */
export function newestUpdate(comments, fallback = 0) {
  return comments.reduce((newest, comment) => Math.max(newest, comment.updatedAt), fallback);
}

/** Where a thread's pin sits on the board: from its node while the node exists, else where it was last placed. */
export function pinPosition(root, nodesById) {
  const anchor = root.anchor;
  const node = anchor ? nodesById.get(anchor.nodeId) : null;
  if (node) return { x: node.x + (anchor.dx ?? 0), y: node.y + (anchor.dy ?? 0), attached: true };
  if (root.x == null || root.y == null) return null;
  return { x: root.x, y: root.y, attached: false };
}

/**
 * Threads whose stored fallback position no longer matches where their object put them: `{ id, body }` with the
 * unchanged anchor and the fresh x/y. Keeping x/y current means a thread whose object is deleted stays where
 * the object last was.
 */
export function driftedAnchors(threads, nodesById, tolerance = 1) {
  const drifted = [];
  for (const { root } of threads) {
    const position = root.deleted ? null : pinPosition(root, nodesById);
    if (!position?.attached) continue;
    if (root.x != null && root.y != null && Math.abs(root.x - position.x) <= tolerance && Math.abs(root.y - position.y) <= tolerance) continue;
    drifted.push({ id: root.id, body: { anchorNodeId: root.anchor.nodeId, anchorDx: root.anchor.dx ?? 0, anchorDy: root.anchor.dy ?? 0, x: position.x, y: position.y } });
  }
  return drifted;
}

/** The request body that drops a thread at `world`: attached to `node` when one is under it, else free-standing. */
export function moveAnchor(world, node) {
  return node ? threadAnchor(world, node) : { anchorNodeId: null, anchorDx: null, anchorDy: null, x: world.x, y: world.y };
}

/** The request body for a new thread dropped at `world`, attached to `node` when one is under it. */
export function threadAnchor(world, node) {
  return node
    ? { anchorNodeId: node.id, anchorDx: world.x - node.x, anchorDy: world.y - node.y, x: world.x, y: world.y }
    : { x: world.x, y: world.y };
}

export function unreadIds(comments, threadId = null) {
  return [...comments].filter((comment) => !comment.read && !comment.deleted && (!threadId || comment.id === threadId || comment.parentId === threadId)).map((comment) => comment.id);
}

/** Threads with an unread comment (the root or a reply), by root id. */
export function unreadThreads(comments) {
  const roots = new Set();
  for (const comment of comments) if (!comment.read && !comment.deleted) roots.add(comment.parentId ?? comment.id);
  return roots;
}

/** Whether a thread lists in the panel and shows on the board: resolved threads only when asked for. */
export function visibleThreads(threads, { showResolved }) {
  return threads.filter(({ root }) => showResolved || !root.resolvedAt);
}

/** The comment's mention of the viewer or a group they are in, for highlighting. */
export function mentionsUser(comment, userId) {
  return Boolean(userId) && (comment.mentions?.users ?? []).includes(String(userId).toLowerCase());
}

// ---- drafts and view preferences kept in this browser ----

const storage = () => {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
};

export const draftKey = (boardId, threadId) => `veevee:comment-draft:${boardId}:${threadId ?? "new"}`;

export function loadDraft(boardId, threadId) {
  try {
    return storage()?.getItem(draftKey(boardId, threadId)) ?? "";
  } catch {
    return "";
  }
}

/** Keeps an unpublished comment; an empty one removes the draft. */
export function saveDraft(boardId, threadId, text) {
  try {
    if (text.trim()) storage()?.setItem(draftKey(boardId, threadId), text);
    else storage()?.removeItem(draftKey(boardId, threadId));
  } catch {
    // Drafts are a convenience; a full or blocked store loses only the draft.
  }
}

const prefKey = (boardId, name) => `veevee:comments:${name}:${boardId}`;

export function loadPref(boardId, name, fallback) {
  try {
    const raw = storage()?.getItem(prefKey(boardId, name));
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function savePref(boardId, name, value) {
  try {
    storage()?.setItem(prefKey(boardId, name), JSON.stringify(value));
  } catch {
    // A per-viewer convenience only.
  }
}
