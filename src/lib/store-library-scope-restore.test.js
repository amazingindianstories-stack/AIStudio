import assert from "node:assert/strict";
import test, { after } from "node:test";
import { JSDOM } from "jsdom";

// The settings writer subscribes only in a browser, so the store loads under a DOM.
const dom = new JSDOM("", { url: "http://localhost" });
globalThis.window = dom.window;
let restoreComposerDraft, useStore;
after(async () => { (await import("./store-runtime.js")).disposeStoreRuntime(); dom.window.close(); });

const SETTINGS_KEY = "veevee-draft-settings-v1";
const TREE = {
  globalFolders: [{ id: "g-coast", name: "Coastline", projectId: null, children: [] }],
  projects: [{ id: "p-1", name: "My Project", folders: [{ id: "p-r02", name: "R02", projectId: "p-1",
    children: [{ id: "p-sc018", name: "SC018", projectId: "p-1", children: [] }] }] }],
};

async function withStore(saved, run) {
  ({ restoreComposerDraft, useStore } = await import("./store.js"));
  const previous = useStore.getState();
  const fetchBefore = globalThis.fetch;
  const storageBefore = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key) };
  globalThis.fetch = async (url) => Response.json(String(url).includes("tree=1") ? TREE
    : { projects: [{ id: "p-1", name: "My Project" }], items: [], assets: [], nextCursor: null, total: 0 });
  useStore.setState({ projects: [], activeProjectId: null, activeFolderId: null, projectScopeSelected: undefined,
    libraryTree: { globalFolders: [], projects: [] }, loadAssets: async () => {} });
  // Seeded after the reset above, which the settings writer would otherwise record.
  values.set(SETTINGS_KEY, JSON.stringify(saved));
  return Promise.resolve(run(values)).finally(() => {
    globalThis.fetch = fetchBefore;
    globalThis.localStorage = storageBefore;
    useStore.setState(previous, true);
  });
}

const scope = () => {
  const { activeProjectId, activeFolderId } = useStore.getState();
  return [activeProjectId, activeFolderId];
};

test("a reload in a Global Library folder reopens the Global Library and that folder", () =>
  withStore({ activeProjectId: null, globalScope: true, activeFolderId: "g-coast" }, async () => {
    restoreComposerDraft();
    await useStore.getState().loadProjects();
    await useStore.getState().loadLibraryTree();
    assert.deepEqual(scope(), [null, "g-coast"], "the workspace does not snap back to My Project");
  }));

test("the global scope is written explicitly so a reload can tell it from the unloaded initial state", () =>
  withStore({}, (values) => {
    useStore.getState().setActiveProject(null);
    useStore.getState().setActiveFolder("g-coast");
    const saved = JSON.parse(values.get(SETTINGS_KEY));
    assert.deepEqual([saved.activeProjectId, saved.globalScope, saved.activeFolderId], [null, true, "g-coast"]);
    useStore.getState().setActiveProject("p-1");
    assert.equal(JSON.parse(values.get(SETTINGS_KEY)).globalScope, false);
  }));

test("a draft with a null project but no global marker restores neither the scope nor a folder", () =>
  withStore({ activeProjectId: null, activeFolderId: "g-coast" }, async () => {
    restoreComposerDraft();
    await useStore.getState().loadProjects();
    assert.deepEqual(scope(), ["p-1", null], "never My Project > a global folder");
  }));

test("a restored folder from another scope is dropped once the tree loads", () =>
  withStore({ activeProjectId: "p-1", activeFolderId: "g-coast" }, async () => {
    restoreComposerDraft();
    await useStore.getState().loadProjects();
    await useStore.getState().loadLibraryTree();
    assert.deepEqual(scope(), ["p-1", null]);
  }));

test("a restored nested project folder survives the tree check", () =>
  withStore({ activeProjectId: "p-1", activeFolderId: "p-sc018" }, async () => {
    restoreComposerDraft();
    await useStore.getState().loadProjects();
    await useStore.getState().loadLibraryTree();
    assert.deepEqual(scope(), ["p-1", "p-sc018"]);
  }));

test("a stale restored project falls back to the default project without its folder", () =>
  withStore({ activeProjectId: "p-deleted", activeFolderId: "p-sc018" }, async () => {
    restoreComposerDraft();
    await useStore.getState().loadProjects();
    assert.deepEqual(scope(), ["p-1", null]);
  }));
