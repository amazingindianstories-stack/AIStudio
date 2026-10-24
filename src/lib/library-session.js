import { emptyLibraryFilters, libraryDateBounds, normalizeLibraryFilters } from "./library-filters";

const key = actor => `veevee-library-filters-v1:${actor}`;
function book(actor) {
  try { return JSON.parse(window.sessionStorage.getItem(key(actor))) || { sources: {} }; }
  catch { return { sources: {} }; }
}

export function readLibrarySession(actor, source) {
  if (!actor || typeof window === "undefined") return null;
  const saved = book(actor), value = saved.sources?.[source];
  const view = typeof saved.groupByDate === "boolean" ? { libraryGroupByDate: saved.groupByDate } : {};
  if (!value) return { ...cleanLibraryQuery(), ...view };
  const filters = normalizeLibraryFilters(value.filters);
  if (libraryDateBounds(filters) === null) Object.assign(filters, { date: "any", from: "", through: "" });
  return { libraryFilters: filters, search: typeof value.search === "string" ? value.search.slice(0, 200) : "",
    librarySort: ["newest", "oldest", "starred"].includes(value.sort) ? value.sort : null, ...view };
}

export function writeLibrarySession(actor, source, state) {
  if (!actor || typeof window === "undefined") return;
  try {
    const previous = book(actor);
    const sources = previous.sources && typeof previous.sources === "object" ? previous.sources : {};
    delete sources[source];
    sources[source] = { filters: normalizeLibraryFilters(state.libraryFilters), search: state.search.slice(0, 200), sort: state.librarySort };
    while (Object.keys(sources).length > 24) delete sources[Object.keys(sources)[0]];
    window.sessionStorage.setItem(key(actor), JSON.stringify({ sources, groupByDate: state.libraryGroupByDate }));
  } catch { /* Private browsing/storage limits must not disable retrieval. */ }
}

export function clearLibrarySession(actor) {
  try { if (actor && typeof window !== "undefined") window.sessionStorage.removeItem(key(actor)); } catch {}
}

export const cleanLibraryQuery = () => ({ libraryFilters: emptyLibraryFilters(), search: "", librarySort: null });
