import { test } from "vitest";
import assert from "node:assert/strict";
import {
  UNSORTED,
  compareInScope,
  matchesScope,
  scopeKey,
  scopeToQuery,
  sortValue,

} from "./feed-scope";
import { decodeCursor, encodeCursor } from "./store-db";
import { historyFilterToParams, parseHistoryFilter } from "./history-query";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

function item(patch = {}) {
  return {
    id: UUID_A,
    kind: "image",
    status: "succeeded",
    prompt: "a cat on a roof",
    model: "Nano Banana Pro",
    aspectRatio: "16:9",
    createdAt: 1000,
    updatedAt: 1000,
    ...patch,
  };
}

function scope(patch = {}) {
  return { tab: "history", projectId: null, folderId: null, kind: "all", q: "", ...patch };
}

// ── scopeKey ────────────────────────────────────────────────────────────────

test("scopeKey ignores project/folder outside the project tab", () => {
  // All assets is global; keying it by whichever project happened to be
  // selected would fragment one cache entry into one per project.
  const a = scopeKey(scope({ tab: "history", projectId: "p1", folderId: "f1" }));
  const b = scopeKey(scope({ tab: "history", projectId: "p2", folderId: "f2" }));
  assert.equal(a, b);
});

test("scopeKey normalises the search term", () => {
  assert.equal(
    scopeKey(scope({ q: "  Cat  " })),
    scopeKey(scope({ q: "cat" }))
  );
});

test("scopeKey separates All-in-project from Unsorted", () => {
  const all = scopeKey(scope({ tab: "project", projectId: "p1", folderId: null }));
  const unsorted = scopeKey(scope({ tab: "project", projectId: "p1", folderId: UNSORTED }));
  assert.notEqual(all, unsorted);
});

test("scopeKey separates the three tabs", () => {
  const keys = new Set([
    scopeKey(scope({ tab: "history" })),
    scopeKey(scope({ tab: "favorites" })),
    scopeKey(scope({ tab: "project", projectId: "p1" })),
  ]);
  assert.equal(keys.size, 3);
});

// ── scopeToQuery ────────────────────────────────────────────────────────────

test("scopeToQuery maps Unsorted to an explicit null folder", () => {
  const q = scopeToQuery(scope({ tab: "project", projectId: "p1", folderId: UNSORTED }));
  assert.equal(q.folderId, null);
});

test("scopeToQuery maps All-in-project to no folder predicate", () => {
  const q = scopeToQuery(scope({ tab: "project", projectId: "p1", folderId: null }));
  assert.equal(q.folderId, undefined);
});

test("scopeToQuery drops project scoping on the global tabs", () => {
  const q = scopeToQuery(scope({ tab: "favorites", projectId: "p1" }));
  assert.equal(q.projectId, undefined);
  assert.equal(q.favorite, true);
});

// ── matchesScope ────────────────────────────────────────────────────────────

test("matchesScope honours the kind filter", () => {
  assert.equal(matchesScope(item({ kind: "video" }), scope({ kind: "image" })), false);
  assert.equal(matchesScope(item({ kind: "image" }), scope({ kind: "image" })), true);
});

test("matchesScope search is case-insensitive on the prompt", () => {
  assert.equal(matchesScope(item(), scope({ q: "CAT" })), true);
  assert.equal(matchesScope(item(), scope({ q: "dog" })), false);
});

test("matchesScope requires a project match on the project tab", () => {
  const s = scope({ tab: "project", projectId: "p1", folderId: null });
  assert.equal(matchesScope(item({ projectId: "p1" }), s), true);
  assert.equal(matchesScope(item({ projectId: "p2" }), s), false);
  assert.equal(matchesScope(item({ projectId: undefined }), s), false);
});

test("matchesScope Unsorted accepts only items with no folder", () => {
  const s = scope({ tab: "project", projectId: "p1", folderId: UNSORTED });
  assert.equal(matchesScope(item({ projectId: "p1" }), s), true);
  assert.equal(matchesScope(item({ projectId: "p1", folderId: "f1" }), s), false);
});

test("matchesScope All-in-project accepts every folder", () => {
  const s = scope({ tab: "project", projectId: "p1", folderId: null });
  assert.equal(matchesScope(item({ projectId: "p1", folderId: "f1" }), s), true);
  assert.equal(matchesScope(item({ projectId: "p1" }), s), true);
});

test("matchesScope favourites requires the star", () => {
  const s = scope({ tab: "favorites" });
  assert.equal(matchesScope(item({ isFavorite: true }), s), true);
  assert.equal(matchesScope(item({ isFavorite: false }), s), false);
});

test("a project tab with no project selected matches nothing", () => {
  // Guards the case where the tab is restored from localStorage before
  // projects have loaded — matching everything would show the whole library
  // as if it belonged to one project.
  const s = scope({ tab: "project", projectId: null });
  assert.equal(matchesScope(item({ projectId: "p1" }), s), false);
});

// ── ordering ────────────────────────────────────────────────────────────────

test("favourites sort by when they were starred, not created", () => {
  const s = scope({ tab: "favorites" });
  const older = item({ id: UUID_A, createdAt: 5000, favoritedAt: 10 });
  const newer = item({ id: UUID_B, createdAt: 1000, favoritedAt: 900 });
  assert.equal(sortValue(newer, s), 900);
  assert.ok(compareInScope(newer, older, s) < 0, "recently starred sorts first");
});

test("favourites with no favoritedAt fall back to createdAt", () => {
  const s = scope({ tab: "favorites" });
  assert.equal(sortValue(item({ createdAt: 42, favoritedAt: undefined }), s), 42);
});

test("ordering breaks createdAt ties by id, matching the server", () => {
  // Batch generation writes several rows inside one millisecond; without a
  // total order the client and server disagree about page boundaries.
  const s = scope();
  const a = item({ id: UUID_A, createdAt: 1000 });
  const b = item({ id: UUID_B, createdAt: 1000 });
  assert.ok(compareInScope(b, a, s) < 0, "higher id sorts first at equal timestamps");
  assert.ok(compareInScope(a, b, s) > 0);
  assert.equal(compareInScope(a, a, s), 0);
});

// ── cursors ─────────────────────────────────────────────────────────────────

test("cursors round-trip", () => {
  const c = { sort: 1758000000000, id: UUID_A };
  assert.deepEqual(decodeCursor(encodeCursor(c)), c);
});

test("malformed cursors decode to undefined rather than a NaN predicate", () => {
  // A NaN in the row comparison silently matches nothing, which would present
  // as "the list just stops" rather than as an error.
  for (const bad of ["", "abc", ".", "123.", "notanumber." + UUID_A, "123.not-a-uuid", null, undefined]) {
    assert.equal(decodeCursor(bad ), undefined, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test("a cursor's id half must be a uuid", () => {
  // It is interpolated into a ::uuid cast, so anything else raises in Postgres.
  assert.equal(decodeCursor("123.'; drop table generations; --"), undefined);
});

// ── wire format round-trip ──────────────────────────────────────────────────

test("filter params round-trip through the server parser", () => {
  const params = historyFilterToParams({
    projectId: "aaaa",
    folderId: null,
    kind: "video",
    favorite: true,
    q: "  neon  ",
  });
  const parsed = parseHistoryFilter(params);
  assert.equal(parsed.projectId, "aaaa");
  assert.equal(parsed.folderId, null, "null folder survives as an explicit 'none'");
  assert.equal(parsed.kind, "video");
  assert.equal(parsed.favorite, true);
  assert.equal(parsed.q, "neon");
});

test("an absent folder is not the same as an unsorted folder on the wire", () => {
  const anyFolder = parseHistoryFilter(historyFilterToParams({ projectId: "p" }));
  const noFolder = parseHistoryFilter(
    historyFilterToParams({ projectId: "p", folderId: null })
  );
  assert.equal(anyFolder.folderId, undefined);
  assert.equal(noFolder.folderId, null);
});

test("kind 'all' is omitted rather than sent as a predicate", () => {
  const parsed = parseHistoryFilter(historyFilterToParams({ kind: "all" }));
  assert.equal(parsed.kind, undefined);
});

test("an over-long search term is truncated on both sides", () => {
  const long = "x".repeat(500);
  const parsed = parseHistoryFilter(historyFilterToParams({ q: long }));
  assert.equal(parsed.q?.length, 200);
});
