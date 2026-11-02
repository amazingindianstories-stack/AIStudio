import test from "node:test";
import assert from "node:assert/strict";
import { emptyCanvasState, validateCanvasState } from "../serialization.js";
import { useCanvasStore } from "../../canvas-store.js";
import { addSlide } from "./slides.js";
import { newFormatNode } from "./model.js";
import { WIREFRAMES, wireframeNode } from "./wireframes.js";
import { patchFormat, setDefaultFormat } from "./actions.js";

async function editableBoard(t, data) {
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  t.mock.method(globalThis, "fetch", async (url, init = {}) =>
    (init.method || "GET") === "PUT" ? json({ ok: true, updatedAt: Date.now() }) : json({ id: "board-1", name: "Board", data, updatedAt: 1, role: "edit" }));
  const store = useCanvasStore;
  store.getState().reset();
  await store.getState().loadBoard("board-1");
  t.after(() => store.getState().reset());
  return store;
}

test("copies follow copied link and slide targets and are never the default view", async (t) => {
  const frame = wireframeNode(WIREFRAMES[0], { x: 0, y: 0 });
  const button = { id: "button", type: "rect", x: 2000, y: 0, w: 80, h: 40, text: "Go", screenLink: frame.id };
  const deck = { ...newFormatNode("deck", { x: 3000, y: 0 }), id: "deck", slides: addSlide([], frame), defaultView: true, viewLocked: true };
  const store = await editableBoard(t, validateCanvasState({ ...emptyCanvasState(), nodes: [frame, button, deck] }));
  const present = () => store.getState().history.present;
  const find = (id) => present().nodes.find((n) => n.id === id);
  store.getState().setSelection([frame.id, "button", "deck"]);
  store.getState().duplicateSelected();
  const copyOf = new Map([frame.id, "button", "deck"].map((id, i) => [id, store.getState().selection[i]]));
  assert.equal(find(copyOf.get("button")).screenLink, copyOf.get(frame.id));
  assert.equal(find(copyOf.get("deck")).slides[0].frameId, copyOf.get(frame.id));
  assert.equal(find(copyOf.get("deck")).defaultView, undefined);
  assert.equal(find(copyOf.get("deck")).viewLocked, undefined);
  assert.equal(find("deck").defaultView, true);
  store.getState().setSelection(["button", "deck"]);
  store.getState().duplicateSelected();
  const [button2, deck2] = store.getState().selection;
  assert.equal(find(button2).screenLink, frame.id);
  assert.equal(find(deck2).slides[0].frameId, frame.id);
});

test("a locked format keeps its content and default view", async (t) => {
  const doc = { ...newFormatNode("doc", { x: 0, y: 0 }), id: "doc", name: "Spec", locked: true };
  const store = await editableBoard(t, validateCanvasState({ ...emptyCanvasState(), nodes: [doc] }));
  const before = store.getState().history.present;
  patchFormat("doc", () => ({ name: "Changed" }));
  setDefaultFormat("doc", true, true);
  assert.equal(store.getState().history.present, before);
});
