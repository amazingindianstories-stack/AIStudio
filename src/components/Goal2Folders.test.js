import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { useStore } from "../lib/store.js";
import { FolderTree, FolderOperationRail, SETTLED_OPERATION_MS, isFolderOperationBusy } from "./FolderTree.jsx";
import { ChildFolderList } from "./ChildFolderList.jsx";
import { ProjectMenu } from "./ProjectMenu.jsx";
import { InlineFolderNameEditor } from "./InlineFolderNameEditor.jsx";

async function withDom(run) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  const keys = ["window", "document", "HTMLElement", "localStorage", "React", "IS_REACT_ACT_ENVIRONMENT"];
  const prior = Object.fromEntries(keys.map((key) => [key, globalThis[key]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, localStorage: dom.window.localStorage, React, IS_REACT_ACT_ENVIRONMENT: true });
  dom.window.HTMLElement.prototype.attachEvent = function () {};
  dom.window.HTMLElement.prototype.detachEvent = function () {};
  const root = createRoot(document.querySelector("#root"));
  const original = useStore.getState();
  try { await run({ dom, root, render: async (component) => act(async () => root.render(component)) }); }
  finally { await act(async () => root.unmount()); useStore.setState(original, true); Object.assign(globalThis, prior); dom.window.close(); }
}

test("three-level full names remain accessible, horizontal controls scroll the contained viewport, and tree keyboard selects", async () => {
  await withDom(async ({ dom, render }) => {
    const name = "Extremely long folder name with an entire descriptive shot sequence";
    const folders = [{ id: "a", name, children: [{ id: "b", name: `${name} second`, children: [{ id: "c", name: `${name} third` }] }] }];
    useStore.setState({ operations: {} });
    const selected = [];
    await render(React.createElement(FolderTree, { folders, activeFolderId: "c", onSelectFolder: (id) => selected.push(id) }));
    assert.equal(document.querySelectorAll('[role="treeitem"]').length, 3);
    assert.equal(document.querySelector('[aria-level="3"]').title, `${name} third`);
    assert.equal(document.querySelector('[aria-level="3"] span.whitespace-nowrap').textContent, `${name} third`);
    const viewport = document.querySelector('[data-testid="folder-hierarchy-viewport"]');
    const scrolls = []; viewport.scrollBy = (value) => scrolls.push(value.left);
    await act(async () => document.querySelector('[aria-label="Scroll folder names right"]').click());
    await act(async () => viewport.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    assert.deepEqual(scrolls, [160, -160]);
    const third = document.querySelector('[aria-level="3"]'); third.focus();
    await act(async () => third.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    assert.deepEqual(selected, ["c"]);
    await act(async () => third.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    assert.equal(document.activeElement.getAttribute("aria-level"), "1");
  });
});

test("folder visibility is non-destructive, compact, and isolated per authenticated actor across remount", async () => {
  await withDom(async ({ render }) => {
    useStore.setState({ currentUser: { id: "actor-one" }, libraryTree: { globalFolders: [{ id: "folder", name: "Folder" }], projects: [] }, counts: {}, operations: {} });
    await render(React.createElement(ChildFolderList));
    assert.equal(document.querySelector('[data-testid="child-folder-list"]'), null);
    await act(async () => document.querySelector('[aria-label="Expand folders"]').click());
    assert.equal(localStorage.getItem("veevee_folders_expanded:actor-one"), "true");
    assert.ok(document.querySelector('[data-testid="child-folder-list"]'));
    await act(async () => document.querySelector('[aria-label="Hide folders"]').click());
    await render(null); await render(React.createElement(ChildFolderList));
    assert.equal(document.querySelector('[data-testid="child-folder-list"]'), null);
    await act(async () => document.querySelector('[aria-label="Show folders"]').click());
    assert.ok(document.querySelector('[data-testid="child-folder-list"]'));
    await act(async () => useStore.setState({ currentUser: { id: "actor-two" } }));
    assert.equal(document.querySelector('[data-testid="child-folder-list"]'), null);
    assert.equal(useStore.getState().libraryTree.globalFolders.length, 1);
  });
});

test("200 projects have an independent scrolling list and pinned action footer", async () => {
  await withDom(async ({ render }) => {
    useStore.setState({ projects: Array.from({ length: 200 }, (_, i) => ({ id: `p${i}`, name: `Project ${i}` })), activeProjectId: "p0" });
    await render(React.createElement(ProjectMenu, { close() {} }));
    assert.equal(document.querySelectorAll('[role="menuitem"]') .length, 204);
    const footer = document.querySelector('[data-testid="project-actions-footer"]');
    assert.match(footer.textContent, /New project.*Rename current project.*Delete current project/);
    assert.ok(footer.classList.contains("shrink-0"));
    const projectItem = Array.from(document.querySelectorAll('[role="menuitem"]')).find((node) => node.textContent === "Project 199");
    assert.ok(projectItem.parentElement.classList.contains("overflow-y-auto"));
    assert.equal(projectItem.parentElement.contains(footer), false);
  });
});

test("operation feedback blocks only the matching folder and retry replays the same logical mutation", async () => {
  await withDom(async ({ render }) => {
    const logical = JSON.stringify(["actor", "moveFolder", ["folder", { type: "global_root" }]]);
    const calls = [];
    useStore.setState({ currentUser: { id: "actor" }, operations: { [logical]: { key: "same-idempotency", operation: "moveFolder", entity: JSON.stringify(["actor", "folder"]), status: "pending", attempt: 1 } }, moveFolder: async (...args) => calls.push(args), loadLibraryTree: async () => {} });
    assert.equal(isFolderOperationBusy(useStore.getState().operations, "folder"), true);
    assert.equal(isFolderOperationBusy(useStore.getState().operations, "independent"), false);
    await render(React.createElement(FolderTree, { folders: [{ id: "folder", name: "Pending folder" }], onSelectFolder() {} }));
    assert.equal(document.querySelector('[role="treeitem"]').getAttribute("draggable"), "false");
    assert.ok(document.querySelector('[inert]'));
    await act(async () => useStore.setState({ operations: { [logical]: { ...useStore.getState().operations[logical], status: "conflicted", error: "Changed elsewhere", attempt: 2 } } }));
    await render(React.createElement(FolderOperationRail));
    assert.match(document.querySelector('[role="status"]').textContent, /Couldn't move folder: it changed elsewhere \(Changed elsewhere\) \(attempt 2\)/);
    await act(async () => Array.from(document.querySelectorAll("button")).find((node) => node.textContent === "Retry").click());
    assert.deepEqual(calls, [["folder", { type: "global_root" }]]);
  });
});

test("the operation rail speaks plain language, shows a few entries and clears finished ones", async () => {
  await withDom(async ({ render }) => {
    const now = Date.now();
    const op = (n, operation, status, extra = {}) => [JSON.stringify(["actor", operation, [`f${n}`]]),
      { key: `k${n}`, operation, status, attempt: 1, startedAt: now - 1000, entity: JSON.stringify(["actor", `f${n}`]), ...extra }];
    useStore.setState({ currentUser: { id: "actor" }, loadLibraryTree: async () => {}, operations: Object.fromEntries([
      op(1, "renameFolder", "confirmed", { completedAt: now - SETTLED_OPERATION_MS - 1 }),
      op(2, "renameFolderGenerations", "confirmed", { completedAt: now }),
      op(3, "renameFolder", "confirmed", { completedAt: now }),
      op(4, "setFolderColor", "failed", { error: "Offline" }),
      op(5, "createFolder", "pending"),
    ]) });
    await render(React.createElement(FolderOperationRail));
    const rows = () => Array.from(document.querySelectorAll('[role="status"] > div')).map((row) => row.querySelector("span").textContent);
    assert.deepEqual(rows(), ["Creating folder…", "Couldn't change folder color: Offline", "Renamed folder"], "newest first, capped at three");
    assert.match(document.querySelector('[role="status"]').textContent, /\+1 more/);
    assert.doesNotMatch(document.querySelector('[role="status"]').textContent, /rename Folder|confirmed|· /, "no internal action names or raw statuses");
    await act(async () => Array.from(document.querySelectorAll("button")).find((node) => node.textContent === "Dismiss").click());
    assert.deepEqual(rows(), ["Creating folder…", "Renamed folder", "Renamed generations to match folder"]);
    await act(async () => useStore.setState({ operations: Object.fromEntries([op(2, "renameFolderGenerations", "confirmed", { completedAt: now - SETTLED_OPERATION_MS - 1 })]) }));
    assert.equal(document.querySelector('[role="status"]'), null, "a finished operation clears itself");
  });
});

test("dismissing a failed operation hides only that attempt, not a later retry of the same operation", async () => {
  await withDom(async ({ render }) => {
    const logical = JSON.stringify(["actor", "renameFolder", ["a", "B"]]);
    const attempt = (n, status) => ({ [logical]: { key: "same-key", operation: "renameFolder", status, error: "Offline", attempt: n, startedAt: Date.now(), entity: JSON.stringify(["actor", "a"]) } });
    useStore.setState({ currentUser: { id: "actor" }, loadLibraryTree: async () => {}, operations: attempt(1, "failed") });
    await render(React.createElement(FolderOperationRail));
    await act(async () => Array.from(document.querySelectorAll("button")).find((node) => node.textContent === "Dismiss").click());
    assert.equal(document.querySelector('[role="status"]'), null);
    await act(async () => useStore.setState({ operations: attempt(2, "pending") }));
    assert.match(document.querySelector('[role="status"]').textContent, /Renaming folder… \(attempt 2\)/);
    await act(async () => useStore.setState({ operations: attempt(2, "failed") }));
    assert.match(document.querySelector('[role="status"]').textContent, /Couldn't rename folder: Offline \(attempt 2\)/);
  });
});

test("inline editor permits one pending commit and explicitly retries failure", async () => {
  await withDom(async ({ dom, render }) => {
    let reject; let calls = 0;
    await render(React.createElement(InlineFolderNameEditor, { initialName: "", label: "Folder name", onCommit: () => { calls++; return new Promise((_, fail) => { reject = fail; }); }, onClose() {} }));
    const input = document.querySelector("input");
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
    await act(async () => { setter.call(input, "New folder"); input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); input.dispatchEvent(new dom.window.KeyboardEvent("keyup", { key: "r", bubbles: true })); });
    await act(async () => document.querySelector("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
    await act(async () => document.querySelector("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
    assert.equal(calls, 1); assert.equal(input.readOnly, true);
    await act(async () => reject(new Error("Offline")));
    assert.match(document.querySelector('[role="alert"]').textContent, /Offline/);
    await act(async () => document.querySelector("form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
    assert.equal(calls, 2);
    await act(async () => reject(new Error("Offline")));
  });
});

test("non-admin folder drags remain enabled when dragover hides payload data, while generation drops are disabled", async () => {
  await withDom(async ({ dom, render }) => {
    const folders = [{ id: 'target', name: 'Target', children: [] }];
    localStorage.setItem('veevee_folders_expanded:actor', 'true');
    useStore.setState({ currentUser: { id: 'actor', role: 'user' }, activeFolderId: null, activeProjectId: null,
      libraryTree: { globalFolders: folders, projects: [] }, counts: {}, operations: {} });
    for (const component of [React.createElement(FolderTree, { folders, onSelectFolder() {} }), React.createElement(ChildFolderList)]) {
      await render(component);
      const target = document.querySelector('[role="treeitem"]') || document.querySelector('[data-testid="child-folder-list"] [role="button"]');
      assert.ok(target);
      for (const [type, expected] of [['application/x-veevee-folder', 'move'], ['application/x-veevee-assets', 'none']]) {
        // Browsers expose types during dragover but keep getData protected until drop.
        const dataTransfer = { types: [type], getData: () => '', dropEffect: 'none' };
        const event = new dom.window.Event('dragover', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
        await act(async () => target.dispatchEvent(event));
        assert.equal(dataTransfer.dropEffect, expected);
      }
      await render(null);
    }
  });
});
