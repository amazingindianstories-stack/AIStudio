import type { HistoryFilter } from "./store-db";

/**
 * The wire format for "which slice of the library do you want", shared by the
 * feed route, the counts route and the client store.
 *
 * It lives here rather than in a route file for two reasons: Next.js only
 * permits its own known exports from a route module, and — more importantly —
 * the grid and the count beside it must agree on what a filter means. One
 * parser is how that stays true.
 */

/** Longest prompt substring we will search for. Bounds the ILIKE pattern so a
 *  pathological querystring can't turn into an expensive scan. */
export const MAX_QUERY_LENGTH = 200;

/** Ceiling on `limit`, so a client cannot ask for the whole table in one go. */
export const MAX_PAGE_SIZE = 100;

/**
 * `folderId=none` is the wire form of "in this project, in no folder" and maps
 * to SQL NULL. It has to be distinguishable from an absent folderId, which
 * means "any folder", and a bare empty string cannot carry that distinction.
 */
export function parseHistoryFilter(params: URLSearchParams): HistoryFilter {
  const filter: HistoryFilter = {};

  const projectId = params.get("projectId");
  if (projectId) filter.projectId = projectId;

  const folderId = params.get("folderId");
  if (folderId === "none") filter.folderId = null;
  else if (folderId) filter.folderId = folderId;

  const kind = params.get("kind");
  if (kind === "image" || kind === "video") filter.kind = kind;

  if (params.get("favorite") === "1") filter.favorite = true;

  const q = params.get("q")?.trim();
  if (q) filter.q = q.slice(0, MAX_QUERY_LENGTH);

  return filter;
}

/** The client half of the same contract: a filter → querystring. Kept next to
 *  the parser so the two cannot drift. */
export function historyFilterToParams(filter: {
  projectId?: string | null;
  folderId?: string | null | undefined;
  kind?: "image" | "video" | "all";
  favorite?: boolean;
  q?: string;
}): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.projectId) params.set("projectId", filter.projectId);
  if (filter.folderId === null) params.set("folderId", "none");
  else if (filter.folderId) params.set("folderId", filter.folderId);
  if (filter.kind && filter.kind !== "all") params.set("kind", filter.kind);
  if (filter.favorite) params.set("favorite", "1");
  const q = filter.q?.trim();
  if (q) params.set("q", q.slice(0, MAX_QUERY_LENGTH));
  return params;
}
