

/**
 * A "scope" is the question a library view is asking: which project, which
 * folder, which media kind, which search. Every asset surface in the app is one
 * of these, and the server answers each with an indexed query.
 *
 * Pure and dependency-free so it can be unit-tested without a store, a DOM or a
 * database — the membership rule below is the one piece of logic that has to
 * agree with the SQL in store-db.ts, and it is worth being able to check.
 */

 

/**
 * Sentinel folder id for "in this project, in no folder".
 *
 * `activeFolderId === null` already means "All in project" (any folder), so
 * unsorted needs a value of its own — otherwise the two views collapse into
 * one and there is no way to ask for the backlog on its own. On the wire it
 * becomes `folderId=none`, which the server maps to SQL NULL.
 */
export const UNSORTED = "__unsorted__";

/**
 * Stable identity for a scope, used as the cache key.
 *
 * Field order is fixed and the search term is normalised, so two views that
 * differ only in whitespace or in the order state happened to be assembled
 * share one cache entry instead of silently double-fetching.
 *
 * The project and folder ids are omitted outside the project tab: All assets
 * and Favourites are global, so including the incidentally-selected project
 * would key the same query under a different name for every project the user
 * clicked through.
 */
function extraScope(scope) {
  return Object.fromEntries(["model", "from", "to", "reviewStatus", "sort"].filter((key) => scope[key]).map((key) => [key, scope[key]]));
}
export function scopeKey(scope) {
  const q = scope.q.trim().toLowerCase();
  const extra = Object.keys(extraScope(scope)).length ? ":" + JSON.stringify(extraScope(scope)) : "";
  if (scope.tab === "project") {
    return `project:${scope.projectId ?? "-"}:${scope.folderId ?? "*"}:${scope.kind}:${q}${extra}`;
  }
  return `${scope.tab}:${scope.kind}:${q}${extra}`;
}

/** The querystring shape of a scope. Mirrors parseHistoryFilter on the server. */
export function scopeToQuery(scope)

 {
  if (scope.tab === "project") {
    return {
      ...extraScope(scope),
      projectId: scope.projectId ?? undefined,
      // `undefined` (any folder) and `null` (in no folder) are different
      // queries; "All in project" is the former.
      folderId:
        scope.folderId === UNSORTED ? null : scope.folderId ?? undefined,
      kind: scope.kind,
      q: scope.q,
    };
  }
  return {
    ...extraScope(scope),
    kind: scope.kind,
    favorite: scope.tab === "favorites",
    q: scope.q,
  };
}

/**
 * Does a row belong in this scope?
 *
 * Used to decide whether a live update or an optimistic local change should
 * appear in the feed the user is currently looking at. It must stay equivalent
 * to `filterConditions` in store-db.ts: if it is stricter, a just-finished
 * generation goes missing until reload; if it is looser, a row appears in a
 * view that a refetch would then remove.
 */
export function matchesScope(item, scope) {
  if (scope.model && item.model !== scope.model) return false;
  if (scope.from && item.createdAt < Date.parse(scope.from + "T00:00:00Z")) return false;
  if (scope.to && item.createdAt >= Date.parse(scope.to + "T00:00:00Z") + 86400000) return false;
  if (scope.reviewStatus && (item.productionMetadata?.reviewStatus || "candidate") !== scope.reviewStatus) return false;
  if (scope.kind !== "all" && item.kind !== scope.kind) return false;

  const q = scope.q.trim().toLowerCase();
  if (q && ![item.prompt, item.productionMetadata?.scene, item.productionMetadata?.shot, item.productionMetadata?.take].filter(Boolean).join(" ").toLowerCase().includes(q)) return false;

  if (scope.tab === "favorites") return Boolean(item.isFavorite);

  if (scope.tab === "project") {
    if (!scope.projectId) return false;
    if (item.projectId !== scope.projectId) return false;
    if (scope.folderId === UNSORTED) return !item.folderId;
    // null means "All in project" — every folder qualifies.
    if (scope.folderId === null) return true;
    return item.folderId === scope.folderId;
  }

  return true; // "history" — all assets
}

/**
 * Where a row sorts within a scope. Favourites order by when they were starred,
 * everything else by when it was made — matching the server's ORDER BY, so a
 * locally inserted row lands where a refetch would have put it.
 */
export function sortValue(item, scope) {
  if (scope.tab === "favorites") return item.favoritedAt ?? item.createdAt;
  return item.createdAt;
}

/** Newest-first comparator for a scope, with the same id tiebreaker the server
 *  uses so ordering is total and identical on both sides. */
export function compareInScope(
  a,
  b,
  scope
) {
  const d = sortValue(b, scope) - sortValue(a, scope);
  const direction = scope.sort === "oldest" ? -1 : 1;
  if (d !== 0) return d * direction;
  return (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) * direction;
}
