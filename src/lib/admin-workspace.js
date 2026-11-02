export const FEATURE_MODES = [
  ["all", "Everyone"],
  ["users", "Chosen people"],
  ["none", "No one"],
];

/** Adds or removes one id, keeping the list sorted and free of duplicates. */
export function toggleId(list, id) {
  const set = new Set(list || []);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  return [...set].sort();
}

/** Splits a pasted list of user ids (commas, spaces or lines) into lowercase ids. */
export function parseUserIds(text) {
  return [...new Set(String(text || "").split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
}

/** Datetime-local text to epoch milliseconds, or null when empty or invalid. */
export function timeFromInput(text) {
  if (!text) return null;
  const ms = new Date(text).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function timeToInput(ms) {
  if (ms == null) return "";
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}

export function blankAnnouncement() {
  return { id: "", title: "", body: "", ctaLabel: "", ctaUrl: "", priority: "info", audience: "all", userIds: [], startsAt: null, endsAt: null };
}
