import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { MaintenanceStatus } from "./MaintenanceStatus";
import { PromptComposer } from "./PromptComposer";
import { FolderTree } from "./FolderTree";
import { ProjectMenu } from "./ProjectMenu";
import { MediaCard } from "./MediaCard";
import { FeedBlock } from "./ConversationPanel";
import { UpscalerComposer } from "./UpscalerComposer";
import { HistoryPanel } from "./HistoryPanel";
import { useStore } from "../lib/store";
import { useMaintenance } from "../lib/maintenance-client";
import { MAINTENANCE_MESSAGE } from "../lib/maintenance";

test("an open tab shows the persistent banner, disables writes and restores controls when OFF", async () => {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  const names = ["window", "document", "HTMLElement", "React", "IS_REACT_ACT_ENVIRONMENT", "fetch", "ResizeObserver", "IntersectionObserver", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle", "MutationObserver", "localStorage"];
  const prior = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  const observer = class { observe() {} unobserve() {} disconnect() {} };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, React,
    IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    MutationObserver: dom.window.MutationObserver, localStorage: dom.window.localStorage, ResizeObserver: observer, IntersectionObserver: observer, getComputedStyle: dom.window.getComputedStyle });
  dom.window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  dom.window.HTMLElement.prototype.attachEvent = function () {};
  dom.window.HTMLElement.prototype.detachEvent = function () {};
  let enabled = false, submits = 0;
  globalThis.fetch = async (url) => new Response(JSON.stringify(url === "/api/maintenance" ? { enabled, available: true } : {}));
  const original = useStore.getState();
  const item = { id: "item", kind: "image", status: "succeeded", model: "Nano Banana Pro", prompt: "A mountain", url: "/image.png", filename: "image.png", aspectRatio: "1:1", resolution: "1K", createdAt: 1, userId: "admin" };
  useStore.setState({ prompt: "A mountain", generating: false, mode: "image", model: "Nano Banana Pro", currentUser: { id: "admin", role: "admin" },
    projects: [{ id: "project", name: "Project" }], activeProjectId: "project", libraryTree: { globalFolders: [], projects: [] },
    upscalerMedia: "image", upscalerImage: { url: "/image.png", name: "fixture.png" }, items: [item], selectedIds: [item.id], usersById: {}, assets: [], referenceImages: [], referenceIds: [],
    generate: async () => { submits++; }, loadLibraryTree: async () => {}, loadCounts: async () => {}, loadHistory: async () => {}, loadProjects: async () => {} });
  const root = createRoot(document.querySelector("#root"));
  const refresh = async () => act(async () => { window.dispatchEvent(new window.Event("focus")); await new Promise((resolve) => setTimeout(resolve, 5)); });
  const button = (label) => document.querySelector(`button[aria-label='${label}']`);
  try {
    await act(async () => root.render(React.createElement(MaintenanceStatus, null,
      React.createElement(PromptComposer),
      React.createElement(FolderTree, { folders: [{ id: "folder", name: "Folder", children: [] }], onSelectFolder() {} }),
      React.createElement(ProjectMenu, { close() {} }),
      React.createElement(MediaCard, { item, selectable: true }),
      React.createElement(FeedBlock, { item, index: 0 }),
      React.createElement(UpscalerComposer),
      React.createElement(HistoryPanel))));
    assert.equal(button("Generate").disabled, false);
    enabled = true;
    await refresh();
    const banner = [...document.querySelectorAll("[role=status]")].find((el) => el.textContent === MAINTENANCE_MESSAGE);
    assert.ok(banner);
    assert.equal(banner.querySelector("button"), null, "banner has no dismiss control");
    assert.equal(button("Generate").disabled, true);
    assert.equal(button("Generate again").disabled, true);
    assert.equal([...document.querySelectorAll("button")].find((el) => el.textContent === "Upscale with Magnific").disabled, true);
    assert.equal([...document.querySelectorAll("button")].find((el) => el.textContent === "Replace image").disabled, true);
    assert.ok([...document.querySelectorAll("input[type=file]")].every((el) => el.disabled));
    assert.equal(button("Tree folder actions: Folder").disabled, true);
    assert.equal(document.querySelector("button[title='Create new folder']").disabled, true);
    assert.equal(button("Move").disabled, true);
    const footer = document.querySelector("[data-testid=project-actions-footer]");
    assert.ok([...footer.querySelectorAll("button")].every((el) => el.disabled));
    await act(async () => button("Generate").click());
    assert.equal(submits, 0);
    const card = document.querySelector("[data-asset-card-id=item]");
    await act(async () => card.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })));
    for (const key of ["retry", "favorite", "delete"]) assert.equal(document.querySelector(`[data-menu-item='${key}']`).getAttribute("aria-disabled"), "true", key);
    assert.notEqual(document.querySelector("[data-menu-item=download]").getAttribute("aria-disabled"), "true", "original download stays usable");
    assert.ok([...document.querySelectorAll("button")].some((el) => el.textContent.includes("Global Library") && !el.disabled), "navigation stays usable");
    enabled = false;
    await refresh();
    assert.equal(document.body.textContent.includes(MAINTENANCE_MESSAGE), false);
    assert.equal(button("Generate").disabled, false);
    assert.equal(button("Tree folder actions: Folder").disabled, false);
    assert.equal(document.querySelector("button[title='Create new folder']").disabled, false);
  } finally {
    await act(async () => root.unmount());
    useStore.setState(original, true);
    useMaintenance.setState({ enabled: false });
    Object.assign(globalThis, prior);
    dom.window.close();
  }
});
