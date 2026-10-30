/**
 * Board history: the server's record of who added, edited and deleted which
 * objects (backend/apps/canvas/activity.py), for the History panel and the
 * Object info line. Only people who can edit a board can read its history.
 */
import { apiFetch } from "../api";

const TYPE_LABELS = {
  rect: "rectangle",
  ellipse: "circle",
  triangle: "triangle",
  diamond: "diamond",
  shape: "shape",
  text: "text",
  sticky: "sticky note",
  stack: "sticky stack",
  frame: "frame",
  image: "image",
  connector: "connector",
};

const ACTION_LABELS = { add: "Added", edit: "Edited", delete: "Deleted" };

/** One page of history, newest first; pass the previous page's `next` for older entries. */
export async function fetchBoardActivity(boardId, before) {
  const query = before ? `?before=${encodeURIComponent(before)}` : "";
  const res = await apiFetch(`/api/canvas-boards/${boardId}/activity${query}`, { cache: "no-store" });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed: ${res.status}`);
  return { activity: Array.isArray(json.activity) ? json.activity : [], next: json.next ?? null };
}

/** "Added sticky note", "Deleted connector". */
export function describeChange(entry) {
  return `${ACTION_LABELS[entry.action] ?? "Changed"} ${TYPE_LABELS[entry.nodeType] ?? "object"}`;
}

function dayKey(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/**
 * Entries in date order (newest first) grouped into runs by one person on one
 * day, as `[{key, actorId, at, entries}]`; `at` is the run's newest time.
 */
export function groupActivity(entries) {
  const groups = [];
  for (const entry of entries) {
    const last = groups[groups.length - 1];
    if (last && last.actorId === entry.actorId && dayKey(last.at) === dayKey(entry.at)) {
      last.entries.push(entry);
    } else {
      groups.push({ key: `${entry.actorId}:${entry.at}:${groups.length}`, actorId: entry.actorId, at: entry.at, entries: [entry] });
    }
  }
  return groups;
}

/** "Today", "Yesterday", "3 Oct" or "3 Oct 2025" for a day other than this year's. */
export function formatDay(ms, now = Date.now()) {
  const date = new Date(ms);
  const today = new Date(now);
  if (dayKey(ms) === dayKey(now)) return "Today";
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (dayKey(ms) === dayKey(yesterday.getTime())) return "Yesterday";
  const options = { day: "numeric", month: "short", ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }) };
  return date.toLocaleDateString(undefined, options);
}

/** "14:05" style local time. */
export function formatTime(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** "just now", "5 min ago", "Today 14:05", "Yesterday 09:12" or "3 Oct 14:05". */
export function formatWhen(ms, now = Date.now()) {
  const ago = now - ms;
  if (ago >= 0 && ago < 60_000) return "just now";
  if (ago >= 0 && ago < 3_600_000) return `${Math.floor(ago / 60_000)} min ago`;
  return `${formatDay(ms, now)} ${formatTime(ms)}`;
}
