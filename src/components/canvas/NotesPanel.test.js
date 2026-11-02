import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { NotesPanel } from "./NotesPanel.jsx";
import { useCanvasStore } from "../../lib/canvas-store.js";
import { useNotesPanel } from "../../lib/notes-panel.js";
import { emptyCanvasState } from "../../lib/canvas/serialization.js";

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

async function openNotes(boardRole) {
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost", pretendToBeVisual: true });
  const names = ["window", "document", "HTMLElement", "Node", "React", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const prior = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, React,
    IS_REACT_ACT_ENVIRONMENT: true, fetch: async () => json({ users: [] }) });
  useCanvasStore.setState({ boardId: "board-1", loaded: true, boardRole, serverVersion: 1,
    history: { past: [], present: emptyCanvasState(), future: [] } });
  const root = createRoot(document.querySelector("#root"));
  await act(async () => root.render(React.createElement(NotesPanel)));
  await act(async () => useNotesPanel.setState({ open: true }));
  const footer = document.querySelector("aside[aria-label='Board notes'] footer").textContent;
  const labels = [...document.querySelectorAll("aside button")].map((button) => button.textContent.trim()).filter(Boolean);
  await act(async () => root.unmount());
  useNotesPanel.setState({ open: false, pinned: false });
  useCanvasStore.getState().reset();
  Object.assign(globalThis, prior);
  dom.window.close();
  return { footer, labels };
}

test("the notes footer tells editors how to edit and tells viewers and commenters nothing they cannot do", async () => {
  const editor = await openNotes("edit");
  assert.equal(editor.footer.includes("Double-click the text to edit"), true);
  assert.deepEqual(editor.labels.filter((label) => ["Link selection", "Edit"].includes(label)), ["Link selection", "Edit"]);
  for (const role of ["view", "comment"]) {
    const reader = await openNotes(role);
    assert.equal(reader.footer, "");
    assert.deepEqual(reader.labels, []);
  }
});
