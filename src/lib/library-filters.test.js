import assert from "node:assert/strict";
import test from "node:test";
import { activeLibraryFilters, emptyLibraryFilters, libraryDateBounds, libraryDayLabel, localDateKey, libraryDateLabel, matchesLibraryFilters } from "./library-filters";
import { scopeKey, scopeToQuery, matchesScope, compareInScope } from "./feed-scope";
import { historyFilterToParams } from "./history-query";
import { packDateSections } from "../components/AssetGrid";
import { getNextGridFocus } from "./grid-navigation";
import { resolveStep } from "./viewer-navigation";

test("metadata filters use OR within facets, AND across facets, and preserve unknown video stage", () => {
  const filters = { ...emptyLibraryFilters(), models: ["seedance-25", "seedance"], stages: ["draft"] };
  const row = { kind: "video", model: "Seedance 2.5", draftMode: true };
  assert.equal(matchesLibraryFilters(row, filters), true);
  assert.equal(matchesLibraryFilters({ ...row, model: "Seedance 2.0" }, filters), true);
  assert.equal(matchesLibraryFilters({ ...row, draftMode: undefined }, { ...filters, stages: ["final"] }), false);
  assert.equal(matchesLibraryFilters({ ...row, kind: "image" }, filters), false);
  assert.equal(matchesLibraryFilters({ ...row, resolution: "4K" }, { ...emptyLibraryFilters(), resolutions: ["image:4k"] }), false);
});

test("all predicates participate in wire transport, cache identity and live membership", () => {
  const scope = { tab: "folder", folderId: "folder", kind: "all", q: "mountain", filters: { ...emptyLibraryFilters(), models: ["seedance-25"], resolutions: ["video:1080p"], stages: ["draft"] } };
  const params = historyFilterToParams(scopeToQuery(scope));
  assert.deepEqual(params.getAll("model"), ["seedance-25"]);
  assert.deepEqual(params.getAll("resolution"), ["video:1080p"]);
  assert.equal(params.get("folderId"), "folder");
  const row = { id: "a", folderId: "folder", prompt: "mountain", kind: "video", model: "Seedance 2.5", resolution: "1080p", draftMode: true };
  assert.equal(matchesScope(row, scope), true);
  assert.equal(matchesScope({ ...row, folderId: "elsewhere" }, scope), false);
  assert.equal(matchesScope({ ...row, draftMode: false }, scope), false);
  assert.notEqual(scopeKey(scope), scopeKey({ ...scope, filters: emptyLibraryFilters() }));
  assert.equal(scopeKey({ ...scope, filters: { ...scope.filters, models: ["seedance", "seedance-25"] } }), scopeKey({ ...scope, filters: { ...scope.filters, models: ["seedance-25", "seedance", "seedance"] } }));
});

test("local calendar presets include today, accept inclusive end dates and follow DST", () => {
  const prior = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const now = new Date(2026, 2, 8, 14).getTime();
    const bounds = libraryDateBounds({ date: "today" }, now);
    assert.equal(bounds.createdBefore - bounds.createdFrom, 23 * 3600000);
    assert.equal(localDateKey(bounds.createdFrom), "2026-03-08");
    const week = libraryDateBounds({ date: "week" }, now);
    assert.equal(localDateKey(week.createdFrom), "2026-03-02");
    assert.equal(localDateKey(week.createdBefore), "2026-03-09");
    assert.equal(libraryDateBounds({ date: "custom", from: "2026-02-30", through: "2026-03-02" }), null);
    assert.equal(libraryDateLabel("2025-10-20", new Date(2026, 9, 24).getTime()), "20 Oct 2025");
    assert.equal(libraryDateLabel("2026-10-23", new Date(2026, 9, 24).getTime()), "Yesterday");
  } finally { if (prior === undefined) delete process.env.TZ; else process.env.TZ = prior; }
});

test("day packs append without moving old cards and publish every viewer column across days", () => {
  const stamp = day => new Date(2026, 9, day, 12).getTime();
  const rows = [
    { id: "a", createdAt: stamp(24), aspectRatio: "9:16" },
    { id: "b", createdAt: stamp(24), aspectRatio: "16:9" },
    { id: "c", createdAt: stamp(23), aspectRatio: "1:1" },
    { id: "d", createdAt: stamp(23), aspectRatio: "16:9" },
  ];
  const before = packDateSections(rows, 400, 160);
  const after = packDateSections([...rows, { id: "e", createdAt: stamp(23), aspectRatio: "3:4" }], 400, 160);
  assert.equal(before.sections.length, 2);
  for (const row of rows) assert.equal(after.centers[row.id], before.centers[row.id]);
  assert.deepEqual(before.columns.map(column => column.map(row => row.id)), [["a", "c"], ["b", "d"]]);
  assert.equal(getNextGridFocus(before.columns, "c", "right", rows, { centers: before.centers }), "d");
  assert.deepEqual(resolveStep({ list: rows, columns: before.columns.map(column => column.map(row => row.id)), currentId: "a", key: "ArrowDown" }), { id: "c" });
  assert.equal(packDateSections(rows, 400, 160, false).sections.length, 1);
  assert.ok(compareInScope(rows[2], rows[0], { sort: "oldest" }) < 0);
});

test("active dimensions follow the dialog's category order and day labels stay human", () => {
  const filters = { ...emptyLibraryFilters(), stages: ["draft"], date: "week", models: ["seedance-25"], types: ["video"], favorite: true };
  assert.deepEqual(activeLibraryFilters(filters), ["types", "favorite", "models", "date", "stages"]);
  const now = new Date(2026, 9, 24, 12).getTime();
  assert.equal(libraryDayLabel("2026-10-18", now), "18 Oct");
  assert.equal(libraryDayLabel("2025-12-31", now), "31 Dec 2025");
  assert.equal(libraryDateLabel("2026-10-24", now), "Today");
});
