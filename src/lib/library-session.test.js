import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { emptyLibraryFilters } from "./library-filters";
import { readLibrarySession, writeLibrarySession, clearLibrarySession } from "./library-session";

test("returning to a source restores its own query while View is shared and actors stay isolated", () => {
  const before = globalThis.window, dom = new JSDOM("", { url: "http://localhost" });
  globalThis.window = dom.window;
  try {
    const state = { libraryFilters: { ...emptyLibraryFilters(), models: ["seedance-25"] }, search: "mountain", filterKind: "all", librarySort: "oldest", libraryGroupByDate: false };
    writeLibrarySession("artist", "folder:a", state);
    assert.equal(readLibrarySession("artist", "folder:b").search, "");
    assert.deepEqual(readLibrarySession("artist", "folder:b").libraryFilters.models, []);
    assert.equal(readLibrarySession("artist", "folder:b").libraryGroupByDate, false);
    assert.equal(readLibrarySession("another-artist", "folder:a").search, "");
    writeLibrarySession("artist", "folder:b", { ...state, search: "ocean", libraryFilters: emptyLibraryFilters() });
    assert.equal(readLibrarySession("artist", "folder:a").search, "mountain");
    assert.deepEqual(readLibrarySession("artist", "folder:a").libraryFilters.models, ["seedance-25"]);
    clearLibrarySession("artist");
    assert.equal(window.sessionStorage.length, 0);
  } finally { globalThis.window = before; dom.window.close(); }
});
