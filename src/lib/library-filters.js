import { getModelDefinition } from "./model-registry";

export const LIBRARY_FILTER_ARRAYS = ["types", "models", "resolutions", "aspects", "durations", "stages", "creators", "statuses", "bitrates"];
export const DATE_PRESETS = { any: "Any time", today: "Today", yesterday: "Yesterday", week: "Last 7 days", month: "Last 30 days", thisMonth: "This month", custom: "Custom range" };
export const FILTER_LABELS = { types: "Type", models: "Model", resolutions: "Resolution", aspects: "Aspect", durations: "Duration", stages: "Stage", creators: "Creator", statuses: "Status", bitrates: "Bitrate", favorite: "Favourites", date: "Date created" };
export const FILTER_VALUES = {
  types: [["image", "Images"], ["video", "Videos"], ["depth", "Depth"]],
  durations: [["short", "Up to 5s"], ["medium", "6-10s"], ["long", "Over 10s"], ["unknown", "Not recorded"]],
  stages: [["draft", "Draft"], ["final", "Final"], ["unknown", "Not recorded"]],
  statuses: [["ready", "Ready"], ["creating", "Creating"], ["failed", "Failed"]],
  bitrates: [["high", "High"], ["standard", "Standard"], ["unknown", "Not recorded"]],
};

export function emptyLibraryFilters() {
  return { ...Object.fromEntries(LIBRARY_FILTER_ARRAYS.map(key => [key, []])), favorite: false, date: "any", from: "", through: "" };
}

export function normalizeLibraryFilters(value = {}) {
  const result = emptyLibraryFilters();
  for (const key of LIBRARY_FILTER_ARRAYS) {
    const values = Array.isArray(value[key]) ? value[key] : [];
    result[key] = [...new Set(values.filter(item => typeof item === "string" && item.length > 0 && item.length <= 200 &&
      (!FILTER_VALUES[key] || FILTER_VALUES[key].some(([id]) => id === item))).map(item =>
      key === "models" ? getModelDefinition(item)?.id || item : key === "resolutions" || key === "creators" ? item.toLowerCase() : item))].sort().slice(0, 50);
  }
  result.favorite = value.favorite === true;
  result.date = Object.hasOwn(DATE_PRESETS, value.date) ? value.date : "any";
  result.from = typeof value.from === "string" ? value.from.slice(0, 10) : "";
  result.through = typeof value.through === "string" ? value.through.slice(0, 10) : "";
  return result;
}

export function activeLibraryFilters(value) {
  const filters = normalizeLibraryFilters(value);
  return [...LIBRARY_FILTER_ARRAYS.filter(key => filters[key].length), ...(filters.favorite ? ["favorite"] : []), ...(filters.date !== "any" ? ["date"] : [])];
}

function parseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

/** Local calendar midnights, including DST; never add a fixed 24h duration. */
export function libraryDateBounds(filters, now = Date.now()) {
  if (!filters || filters.date === "any" || !filters.date) return {};
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  let start = new Date(today), end = new Date(today);
  end.setDate(end.getDate() + 1);
  switch (filters.date) {
    case "yesterday": start.setDate(start.getDate() - 1); end = today; break;
    case "week": start.setDate(start.getDate() - 6); break;
    case "month": start.setDate(start.getDate() - 29); break;
    case "thisMonth": start.setDate(1); break;
    case "custom": {
      start = parseDate(filters.from);
      end = parseDate(filters.through);
      if (!start || !end || start > end) return null;
      end.setDate(end.getDate() + 1);
      break;
    }
    case "today": break;
    default: return {};
  }
  return { createdFrom: start.getTime(), createdBefore: end.getTime() };
}

const WIRE_FIELDS = { types: "type", models: "model", resolutions: "resolution", aspects: "aspect", durations: "durationBucket", stages: "stage", creators: "creator", statuses: "status", bitrates: "bitrate" };
export function libraryFilterQuery(value, now) {
  const filters = normalizeLibraryFilters(value);
  return { ...Object.fromEntries(LIBRARY_FILTER_ARRAYS.filter(key => filters[key].length).map(key => [WIRE_FIELDS[key], filters[key]])),
    ...(filters.favorite ? { favorite: true } : {}), ...libraryDateBounds(filters, now) };
}

export function appendLibraryQuery(params, query) {
  for (const field of Object.values(WIRE_FIELDS)) {
    for (const value of query[field] || []) params.append(field, value);
  }
  for (const field of ["createdFrom", "createdBefore", "sort"]) {
    if (query[field] !== undefined && query[field] !== null && query[field] !== "") params.set(field, String(query[field]));
  }
  return params;
}

export function matchesLibraryFilters(item, value, now) {
  const filters = normalizeLibraryFilters(value);
  const any = (key, actual) => !filters[key].length || filters[key].includes(actual);
  const model = getModelDefinition(item.model)?.id || item.model;
  const resolution = `${item.kind}:${item.resolution?.trim().toLowerCase() || "unknown"}`;
  const duration = item.duration == null ? "unknown" : item.duration > 10 ? "long" : item.duration >= 6 ? "medium" : item.duration > 0 ? "short" : "";
  const stage = item.draftMode === true ? "draft" : item.draftMode === false ? "final" : "unknown";
  const status = item.status === "succeeded" ? "ready" : ["queued", "running"].includes(item.status) ? "creating" : item.status;
  if (!any("types", item.kind) || !any("models", model) || !any("resolutions", resolution) || !any("aspects", item.aspectRatio) ||
      !any("creators", item.userId || "unknown") || !any("statuses", status) || filters.favorite && !item.isFavorite) return false;
  if (filters.durations.length && (item.kind !== "video" || !any("durations", duration))) return false;
  if (filters.stages.length && (item.kind !== "video" || !any("stages", stage))) return false;
  if (filters.bitrates.length && (item.kind !== "video" || !any("bitrates", item.bitrateMode?.trim().toLowerCase() || "unknown"))) return false;
  const bounds = libraryDateBounds(filters, now);
  return bounds !== null && (bounds.createdFrom === undefined || item.createdAt >= bounds.createdFrom) &&
    (bounds.createdBefore === undefined || item.createdAt < bounds.createdBefore);
}

export function localDateKey(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "unknown";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function libraryDateLabel(key, now = Date.now()) {
  if (key === "unknown") return "Date unavailable";
  const today = new Date(now), yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === localDateKey(today)) return "Today";
  if (key === localDateKey(yesterday)) return "Yesterday";
  const date = parseDate(key);
  return date?.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) }) || "Date unavailable";
}

/** The identity of navigation only; filters/search belong to that source. */
export function librarySourceKey(scope) {
  if (scope.tab === "project") return `project:${scope.projectId || "-"}:${scope.folderId ?? "*"}`;
  if (scope.tab === "folder" || scope.tab === "library") return `${scope.tab}:${scope.folderId ?? "*"}`;
  return scope.tab;
}
