import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PREFS, MAX_RECENT_BOARDS, clearRecentBoards, parsePrefs, readRecentBoards, rememberBoard, useBoardPrefs } from "./board-prefs.js";

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
  assert.deepEqual(parsePrefs({ singleKeyShortcuts: "no", toolbarOrder: ["a", 3], toolbarHidden: "x", recentBoards: [{ id: "b", projectId: "p" }], extra: true }), {
    singleKeyShortcuts: true,
    toolbarOrder: ["a"],
    toolbarHidden: [],
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
  useStorage(t, { "veevee-board-prefs-v1:me": JSON.stringify([{ id: 1 }, { id: "old", projectId: "p" }]) });
  assert.deepEqual(readRecentBoards("nobody"), []);
  for (let i = 0; i < MAX_RECENT_BOARDS + 2; i += 1) rememberBoard("me", { id: `b${i}`, projectId: "p", name: `Board ${i}` });
  rememberBoard("me", { id: "b5", projectId: "p", name: "Board 5" });
  const recent = readRecentBoards("me").map((b) => b.id);
  assert.equal(recent.length, MAX_RECENT_BOARDS);
  assert.deepEqual(recent.slice(0, 3), ["b5", "b9", "b8"]);
  assert.equal(new Set(recent).size, recent.length);
});

test("another account on the same browser never sees someone's recent boards, and signing out forgets them", (t) => {
  const map = useStorage(t);
  rememberBoard("alice", { id: "secret", projectId: "p", name: "Alice's launch plan" });
  rememberBoard(undefined, { id: "anon", projectId: "p", name: "Signed out" });
  assert.deepEqual(readRecentBoards("bob"), []);
  assert.deepEqual(readRecentBoards(undefined), []);
  assert.ok(![...map.values()].some((v) => v.includes("Signed out")));
  // Device prefs stay shared and never carry board names.
  resetPrefs();
  useBoardPrefs.getState().setPrefs({ singleKeyShortcuts: false });
  assert.doesNotMatch(map.get("veevee-board-prefs-v1"), /launch plan/);

  rememberBoard("bob", { id: "mine", projectId: "q", name: "Bob's board" });
  assert.deepEqual(readRecentBoards("bob").map((b) => b.id), ["mine"]);
  assert.deepEqual(readRecentBoards("alice").map((b) => b.id), ["secret"]);

  clearRecentBoards("alice");
  assert.deepEqual(readRecentBoards("alice"), []);
  assert.deepEqual(readRecentBoards("bob").map((b) => b.id), ["mine"]);
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
