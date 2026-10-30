import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PREFS, MAX_RECENT_BOARDS, parsePrefs, useBoardPrefs } from "./board-prefs.js";

function useStorage(t, initial = {}) {
  const map = new Map(Object.entries(initial));
  const value = { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
  const had = Object.prototype.hasOwnProperty.call(globalThis, "localStorage");
  const prior = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", { value, configurable: true, writable: true });
  t.after(() => {
    if (had) Object.defineProperty(globalThis, "localStorage", { value: prior, configurable: true, writable: true });
    else delete globalThis.localStorage;
  });
  return map;
}

function resetPrefs() {
  useBoardPrefs.setState({ ...DEFAULT_PREFS, hydrated: false });
}

test("stored prefs are coerced, and anything unknown falls back to the default", () => {
  assert.deepEqual(parsePrefs(null), DEFAULT_PREFS);
  assert.deepEqual(parsePrefs({ singleKeyShortcuts: "no", toolbarOrder: ["a", 3], toolbarHidden: "x", recentBoards: [{ id: "b", projectId: "p" }, { id: 1 }], extra: true }), {
    singleKeyShortcuts: true,
    toolbarOrder: ["a"],
    toolbarHidden: [],
    recentBoards: [{ id: "b", projectId: "p", name: "" }],
  });
  assert.equal(parsePrefs({ singleKeyShortcuts: false }).singleKeyShortcuts, false);
});

test("prefs save to this browser and read back after a reload", (t) => {
  const map = useStorage(t);
  resetPrefs();
  useBoardPrefs.getState().setPrefs({ singleKeyShortcuts: false });
  assert.equal(useBoardPrefs.getState().singleKeyShortcuts, false);
  assert.equal(JSON.parse(map.get("veevee-board-prefs-v1")).singleKeyShortcuts, false);

  resetPrefs();
  useBoardPrefs.getState().hydrate();
  assert.equal(useBoardPrefs.getState().singleKeyShortcuts, false);
  resetPrefs();
});

test("a change before hydration keeps the other saved prefs", (t) => {
  useStorage(t, { "veevee-board-prefs-v1": JSON.stringify({ toolbarHidden: ["ai"] }) });
  resetPrefs();
  useBoardPrefs.getState().setPrefs({ singleKeyShortcuts: false });
  assert.deepEqual(useBoardPrefs.getState().toolbarHidden, ["ai"]);
  resetPrefs();
});

test("recent boards put the newest first, without duplicates, up to the limit", (t) => {
  useStorage(t);
  resetPrefs();
  const { rememberBoard } = useBoardPrefs.getState();
  for (let i = 0; i < MAX_RECENT_BOARDS + 2; i += 1) rememberBoard({ id: `b${i}`, projectId: "p", name: `Board ${i}` });
  rememberBoard({ id: "b5", projectId: "p", name: "Board 5" });
  const recent = useBoardPrefs.getState().recentBoards.map((b) => b.id);
  assert.equal(recent.length, MAX_RECENT_BOARDS);
  assert.deepEqual(recent.slice(0, 3), ["b5", "b9", "b8"]);
  assert.equal(new Set(recent).size, recent.length);
  resetPrefs();
});

test("blocked storage keeps prefs for the session", (t) => {
  const value = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  const had = Object.prototype.hasOwnProperty.call(globalThis, "localStorage");
  const prior = globalThis.localStorage;
  Object.defineProperty(globalThis, "localStorage", { value, configurable: true, writable: true });
  t.after(() => {
    if (had) Object.defineProperty(globalThis, "localStorage", { value: prior, configurable: true, writable: true });
    else delete globalThis.localStorage;
  });
  resetPrefs();
  useBoardPrefs.getState().setPrefs({ toolbarHidden: ["frame"] });
  assert.deepEqual(useBoardPrefs.getState().toolbarHidden, ["frame"]);
  resetPrefs();
});
