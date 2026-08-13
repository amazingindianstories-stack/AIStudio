import assert from "node:assert/strict";
import test from "node:test";
import {
  parseHistoryFilter,
  historyFilterToParams,
  MAX_QUERY_LENGTH,
  MAX_PAGE_SIZE,
} from "./history-query";

// This is the one filter⇄querystring parser shared by the feed route, the
// counts route, and the client (see the module's own docstring) — until now
// it had zero test coverage on either side of the split (checked: no
// equivalent test exists for history_query.py either). Nothing below caught
// a live bug during review, but it's load-bearing wire-format logic with no
// regression protection at all, which is the actual risk being closed here.

test("parseHistoryFilter: empty querystring produces an empty filter", () => {
  assert.deepEqual(parseHistoryFilter(new URLSearchParams()), {});
});

test("parseHistoryFilter: projectId is read through as-is", () => {
  const filter = parseHistoryFilter(new URLSearchParams("projectId=p1"));
  assert.equal(filter.projectId, "p1");
});

test("parseHistoryFilter: folderId=none maps to explicit null (in this project, in no folder)", () => {
  const filter = parseHistoryFilter(new URLSearchParams("folderId=none"));
  assert.equal(filter.folderId, null);
  assert.ok("folderId" in filter);
});

test("parseHistoryFilter: an absent folderId means any folder — not present in the filter at all", () => {
  const filter = parseHistoryFilter(new URLSearchParams());
  assert.equal("folderId" in filter, false);
});

test("parseHistoryFilter: a real folderId is read through as-is, distinct from 'none'", () => {
  const filter = parseHistoryFilter(new URLSearchParams("folderId=f1"));
  assert.equal(filter.folderId, "f1");
});

test("parseHistoryFilter: kind accepts only image/video, anything else (including 'all') is dropped", () => {
  assert.equal(parseHistoryFilter(new URLSearchParams("kind=image")).kind, "image");
  assert.equal(parseHistoryFilter(new URLSearchParams("kind=video")).kind, "video");
  assert.equal("kind" in parseHistoryFilter(new URLSearchParams("kind=all")), false);
  assert.equal("kind" in parseHistoryFilter(new URLSearchParams("kind=bogus")), false);
});

test("parseHistoryFilter: favorite is true only for the literal string '1'", () => {
  assert.equal(parseHistoryFilter(new URLSearchParams("favorite=1")).favorite, true);
  assert.equal("favorite" in parseHistoryFilter(new URLSearchParams("favorite=true")), false);
  assert.equal("favorite" in parseHistoryFilter(new URLSearchParams("favorite=0")), false);
  assert.equal("favorite" in parseHistoryFilter(new URLSearchParams()), false);
});

test("parseHistoryFilter: q is trimmed", () => {
  const filter = parseHistoryFilter(new URLSearchParams("q=" + encodeURIComponent("  hello  ")));
  assert.equal(filter.q, "hello");
});

test("parseHistoryFilter: whitespace-only q is dropped, not stored as an empty/blank string", () => {
  const filter = parseHistoryFilter(new URLSearchParams("q=" + encodeURIComponent("   ")));
  assert.equal("q" in filter, false);
});

test("parseHistoryFilter: q is truncated to MAX_QUERY_LENGTH so a pathological querystring can't produce an expensive scan", () => {
  const long = "x".repeat(MAX_QUERY_LENGTH + 500);
  const filter = parseHistoryFilter(new URLSearchParams("q=" + long));
  assert.equal(filter.q.length, MAX_QUERY_LENGTH);
});

test("historyFilterToParams: empty filter produces an empty querystring", () => {
  assert.equal(historyFilterToParams({}).toString(), "");
});

test("historyFilterToParams: folderId null round-trips to 'none'", () => {
  const params = historyFilterToParams({ folderId: null });
  assert.equal(params.get("folderId"), "none");
});

test("historyFilterToParams: kind 'all' is stripped, matching the parser dropping it too", () => {
  const params = historyFilterToParams({ kind: "all" });
  assert.equal(params.has("kind"), false);
});

test("historyFilterToParams: favorite false is not sent, only true is", () => {
  assert.equal(historyFilterToParams({ favorite: false }).has("favorite"), false);
  assert.equal(historyFilterToParams({ favorite: true }).get("favorite"), "1");
});

test("historyFilterToParams: q is trimmed and truncated the same way the parser does", () => {
  const params = historyFilterToParams({ q: "  " + "y".repeat(MAX_QUERY_LENGTH + 10) + "  " });
  assert.equal(params.get("q").length, MAX_QUERY_LENGTH);
});

test("round trip: a canonical filter survives filter -> params -> filter unchanged", () => {
  const original = { projectId: "p1", folderId: "f1", kind: "video", favorite: true, q: "sunset" };
  const roundTripped = parseHistoryFilter(historyFilterToParams(original));
  assert.deepEqual(roundTripped, original);
});

test("round trip: the folderId=null 'no folder' case survives the round trip distinctly from 'any folder'", () => {
  const withNoFolder = parseHistoryFilter(historyFilterToParams({ projectId: "p1", folderId: null }));
  const withAnyFolder = parseHistoryFilter(historyFilterToParams({ projectId: "p1" }));
  assert.equal(withNoFolder.folderId, null);
  assert.equal("folderId" in withAnyFolder, false);
});

test("MAX_PAGE_SIZE is exported and positive (guards the route's own limit clamp)", () => {
  assert.ok(MAX_PAGE_SIZE > 0);
});
