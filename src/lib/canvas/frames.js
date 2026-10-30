/**
 * Frame structure helpers: wrap a selection in a frame, size presets, nesting, date-aware duplicate names
 * and pasting into frames at the same position. Pure functions over the board graph.
 */
import { descendantIds } from "./geometry";

export const FRAME_PADDING = 40;

/** Preset frame sizes: slides, paper and devices. Width and height are in board units. */
export const FRAME_PRESETS = [
  { id: "slide-16-9", label: "Slide 16:9", w: 1280, h: 720 },
  { id: "slide-4-3", label: "Slide 4:3", w: 1024, h: 768 },
  { id: "a4-portrait", label: "A4 portrait", w: 794, h: 1123 },
  { id: "a4-landscape", label: "A4 landscape", w: 1123, h: 794 },
  { id: "letter-portrait", label: "Letter portrait", w: 816, h: 1056 },
  { id: "square", label: "Square", w: 800, h: 800 },
  { id: "desktop", label: "Desktop", w: 1440, h: 900 },
  { id: "tablet", label: "Tablet", w: 820, h: 1180 },
  { id: "phone", label: "Phone", w: 390, h: 844 },
];

/** The preset a frame's current size matches, or null. */
export function presetOfFrame(frame) {
  return FRAME_PRESETS.find((p) => Math.round(frame.w) === p.w && Math.round(frame.h) === p.h) ?? null;
}

/** `frame` resized to a preset, keeping its top-left corner. */
export function applyFramePreset(frame, preset) {
  return { ...frame, w: preset.w, h: preset.h };
}

/** Bounds of nodes, or null for none. */
export function boundsOfNodes(nodes) {
  if (!nodes.length) return null;
  const x0 = Math.min(...nodes.map((n) => n.x));
  const y0 = Math.min(...nodes.map((n) => n.y));
  const x1 = Math.max(...nodes.map((n) => n.x + n.w));
  const y1 = Math.max(...nodes.map((n) => n.y + n.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Wraps the selected objects in a new frame. The frame sits behind the first selected object, is
 * the selection's bounds plus `padding`, and becomes the parent of every selected object that is not
 * already inside another selected frame. When the whole selection sits in one frame, the new frame nests
 * inside it. Returns `{ state, frameId }`, or null when nothing can be framed.
 */
export function frameAroundSelection(state, ids, padding = FRAME_PADDING, id = crypto.randomUUID()) {
  const selected = new Set(ids);
  // A frame already holding its selected contents is selected as a unit.
  const members = state.nodes.filter((n) => selected.has(n.id));
  if (!members.length) return null;
  const inside = descendantIds(state.nodes, members.map((n) => n.id));
  const tops = members.filter((n) => !inside.has(n.id));
  const box = boundsOfNodes(members);
  const parents = new Set(tops.map((n) => n.parentId ?? null));
  const sharedParent = parents.size === 1 ? [...parents][0] : null;
  const frame = {
    id,
    type: "frame",
    x: box.x - padding,
    y: box.y - padding,
    w: box.w + padding * 2,
    h: box.h + padding * 2,
    name: "Frame",
    fill: "rgba(255,255,255,0.02)",
    stroke: "rgba(255,255,255,0.12)",
    opacity: 1,
    parentId: sharedParent,
    groupId: null,
  };
  const topIds = new Set(tops.map((n) => n.id));
  const firstIndex = state.nodes.findIndex((n) => selected.has(n.id));
  const nodes = state.nodes.map((n) => (topIds.has(n.id) ? { ...n, parentId: id } : n));
  nodes.splice(firstIndex, 0, frame);
  return { state: { ...state, nodes }, frameId: id };
}

/**
 * The frame a frame belongs in after it was dragged: the smallest other frame that wholly contains it and
 * is not one of its own descendants, or null. Frames nest to any depth.
 */
export function enclosingFrameId(frame, nodes) {
  const own = descendantIds(nodes, [frame.id]);
  let best = null;
  for (const other of nodes) {
    if (other.type !== "frame" || other.id === frame.id || own.has(other.id)) continue;
    const contains = other.x <= frame.x && other.y <= frame.y && other.x + other.w >= frame.x + frame.w && other.y + other.h >= frame.y + frame.h;
    if (!contains) continue;
    if (!best || other.w * other.h < best.w * best.h) best = other;
  }
  return best ? best.id : null;
}

/** Re-parents the given frames after a drag so nesting follows what they now sit inside. */
export function renestFrames(state, frameIds) {
  const wanted = new Set(frameIds);
  let changed = false;
  const nodes = state.nodes.map((n) => {
    if (n.type !== "frame" || !wanted.has(n.id)) return n;
    const parentId = enclosingFrameId(n, state.nodes);
    if (parentId === (n.parentId ?? null)) return n;
    changed = true;
    return { ...n, parentId };
  });
  return changed ? { ...state, nodes } : state;
}

// ---- duplicate with date increment ----

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function capitalized(like, word) {
  if (like === like.toUpperCase() && like.length > 1) return word.toUpperCase();
  if (like[0] === like[0].toUpperCase()) return word[0].toUpperCase() + word.slice(1);
  return word;
}

function addDays(year, month, day, days) {
  const d = new Date(Date.UTC(year, month, day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate() };
}

function pad(n) {
  return String(n).padStart(2, "0");
}

/**
 * The frame title for a duplicate: dates in it move on by one day (`2026-03-31` becomes `2026-04-01`, `Mar 31`
 * becomes `Apr 1`, `Monday` becomes `Tuesday`). A title without a date is unchanged.
 */
export function incrementDates(name) {
  if (typeof name !== "string" || !name) return name;
  let changed = false;
  // 2026-03-31
  let out = name.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (match, y, m, d) => {
    const month = Number(m) - 1;
    const day = Number(d);
    if (month < 0 || month > 11 || day < 1 || day > 31) return match;
    const next = addDays(Number(y), month, day, 1);
    changed = true;
    return `${next.year}-${pad(next.month + 1)}-${pad(next.day)}`;
  });
  const monthNames = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
  const monthIndex = (word) => MONTHS.findIndex((full) => full.startsWith(word.toLowerCase().slice(0, 3)));
  const label = (like, index) => capitalized(like, like.length <= 4 && like.toLowerCase() !== MONTHS[monthIndex(like)] ? MONTHS[index].slice(0, 3) : MONTHS[index]);
  // Mar 31[, 2026]
  out = out.replace(new RegExp(`\\b${monthNames}\\.?\\s+(\\d{1,2})(?:(,?\\s+)(\\d{4}))?\\b`, "gi"), (match, mon, d, sep, y) => {
    const index = monthIndex(mon);
    const day = Number(d);
    if (index < 0 || day < 1 || day > 31) return match;
    const next = addDays(y ? Number(y) : 2024, index, day, 1);
    changed = true;
    return `${label(mon, next.month)} ${next.day}${y ? `${sep}${next.year}` : ""}`;
  });
  // 31 Mar[ 2026]
  out = out.replace(new RegExp(`\\b(\\d{1,2})\\s+${monthNames}\\b(?:(\\s+)(\\d{4}))?`, "gi"), (match, d, mon, sep, y) => {
    const index = monthIndex(mon);
    const day = Number(d);
    if (index < 0 || day < 1 || day > 31) return match;
    const next = addDays(y ? Number(y) : 2024, index, day, 1);
    changed = true;
    return `${next.day} ${label(mon, next.month)}${y ? `${sep}${next.year}` : ""}`;
  });
  if (!changed) {
    const weekday = new RegExp(`\\b(${WEEKDAYS.join("|")})\\b`, "gi");
    out = out.replace(weekday, (match) => {
      const index = WEEKDAYS.indexOf(match.toLowerCase());
      changed = true;
      return capitalized(match, WEEKDAYS[(index + 1) % 7]);
    });
  }
  return changed ? out : name;
}

/**
 * Duplicated frames take the next date in their title. `idMap` maps each source id to its clone's id, as
 * the store's clone builder returns it.
 */
export function renameDuplicatedFrames(clones, idMap, sourceNodes) {
  const names = new Map();
  for (const source of sourceNodes) {
    if (source.type === "frame" && idMap.has(source.id)) names.set(idMap.get(source.id), incrementDates(source.name));
  }
  if (!names.size) return clones;
  return clones.map((clone) => (names.has(clone.id) && names.get(clone.id) !== clone.name ? { ...clone, name: names.get(clone.id) } : clone));
}

// ---- paste into frames ----

/**
 * Where pasted objects land when frames are selected: one copy per selected frame, each keeping the objects'
 * offsets from the frame (or selection) they were copied from. `origin` is the corner the clipboard
 * offsets are measured from. Returns `{ x, y, parentId }` for each destination.
 */
export function pasteDestinations(frames, origin) {
  return frames.map((frame) => ({ dx: frame.x - origin.x, dy: frame.y - origin.y, parentId: frame.id }));
}

/** The corner a copy's offsets are measured from: its source frame's corner, else the selection's. */
export function copyOrigin(selectedNodes, allNodes) {
  const tops = selectedNodes.filter((n) => !selectedNodes.some((o) => o.id === n.parentId));
  const parents = new Set(tops.map((n) => n.parentId ?? null));
  if (parents.size === 1) {
    const parentId = [...parents][0];
    const parent = parentId ? allNodes.find((n) => n.id === parentId && n.type === "frame") : null;
    if (parent) return { x: parent.x, y: parent.y };
  }
  const box = boundsOfNodes(selectedNodes);
  return box ? { x: box.x, y: box.y } : { x: 0, y: 0 };
}
