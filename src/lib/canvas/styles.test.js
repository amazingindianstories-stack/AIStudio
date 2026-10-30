import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  BOARD_COLORS,
  customColors,
  normalizeHex,
  rememberStyle,
  removeCustomColor,
  saveCustomColor,
  styleOf,
  switchType,
  withLastStyle,
} from "./styles";

const store = new Map();
globalThis.localStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};
beforeEach(() => store.clear());

test("the shared palette has 23 colors", () => {
  assert.equal(BOARD_COLORS.length, 23);
  assert.equal(new Set(BOARD_COLORS.map((c) => c.value)).size, 23);
});

test("hex input accepts short and long forms", () => {
  assert.equal(normalizeHex("#ABC"), "#aabbcc");
  assert.equal(normalizeHex("12ab34"), "#12ab34");
  assert.equal(normalizeHex("red"), null);
});

test("custom colors are saved per person, newest first, without repeats", () => {
  saveCustomColor("u1", "#111111");
  saveCustomColor("u1", "#222");
  assert.deepEqual(saveCustomColor("u1", "#111111"), ["#111111", "#222222"]);
  assert.deepEqual(customColors("u2"), []);
  assert.deepEqual(removeCustomColor("u1", "#111111"), ["#222222"]);
  assert.equal(saveCustomColor("u1", "nope").length, 1);
});

test("copy style takes only the style keys of the object's kind", () => {
  const shape = { id: "s", type: "rect", x: 1, y: 2, w: 3, h: 4, fill: "#fff", stroke: "#000", strokeWidth: 2,
    cornerRadius: 8, text: "hi", fontSize: 20, opacity: 0.5 };
  assert.deepEqual(styleOf(shape), { fill: "#fff", stroke: "#000", strokeWidth: 2, fontSize: 20, cornerRadius: 8, opacity: 0.5 });
  assert.deepEqual(styleOf({ id: "i", type: "image", opacity: 1 }), { opacity: 1 });
});

test("new objects take the person's last style for their kind", () => {
  rememberStyle("u1", "sticky", { fill: "#3a3a3a", color: "#f5f5f5", opacity: 0.2 });
  rememberStyle("u1", "sticky", { fontSize: 24 });
  const node = { id: "n", type: "sticky", fill: "#e3c56a", color: "#1c1a12", fontSize: 16, autoFit: true };
  assert.deepEqual(withLastStyle(node, "u1"), { id: "n", type: "sticky", fill: "#3a3a3a", color: "#f5f5f5", fontSize: 24 });
  assert.deepEqual(withLastStyle(node, "u2"), node);
  rememberStyle("u1", "shape", { stroke: "#ff0000" });
  assert.equal(withLastStyle({ id: "e", type: "ellipse", stroke: "#000" }, "u1").stroke, "#ff0000");
});

test("choosing the default font is remembered as no font, never as a null one", () => {
  rememberStyle("u1", "text", { fontFamily: "lora", color: "#123abc" });
  rememberStyle("u1", "text", { fontFamily: null });
  const node = { id: "t", type: "text", text: "", fontSize: 16, align: "left", color: "#ffffff" };
  assert.deepEqual(withLastStyle(node, "u1"), { ...node, color: "#123abc" });
});

test("switching type keeps id, place, text and colors and drops what the type lacks", () => {
  const sticky = { id: "a", type: "sticky", x: 1, y: 2, w: 200, h: 200, opacity: 1, parentId: "f", groupId: null,
    text: "hi", marks: [[0, 2, "b"]], fill: "#7fae86", fontSize: 18, color: "#1c1a12", tagIds: ["t"],
    reactions: { "👍": ["u"] }, createdBy: "u", locked: true };
  const shape = switchType(sticky, "ellipse");
  assert.deepEqual(shape, { id: "a", type: "ellipse", x: 1, y: 2, w: 200, h: 200, opacity: 1, parentId: "f", groupId: null,
    createdBy: "u", locked: true, text: "hi", marks: [[0, 2, "b"]], fill: "#7fae86", stroke: "rgba(255,255,255,0.55)",
    strokeWidth: 2, fontSize: 18, color: "#1c1a12" });
  const back = switchType(shape, "sticky");
  assert.deepEqual([back.type, back.fill, back.text, back.color], ["sticky", "#7fae86", "hi", "#1c1a12"]);
  const text = switchType(sticky, "text");
  assert.deepEqual([text.type, text.text, text.color, text.align, "fill" in text], ["text", "hi", "#ffffff", "left", false]);
  const note = switchType({ id: "t", type: "text", x: 0, y: 0, w: 600, h: 32, text: "x", fontSize: 16, align: "left", color: "#fff" }, "sticky");
  assert.deepEqual([note.w, note.h, note.fill], [400, 400, "#e3c56a"]);
  const empty = switchType({ id: "r", type: "rect", x: 0, y: 0, w: 1, h: 1, fill: "#fff", stroke: "#000", strokeWidth: 1 }, "diamond");
  assert.equal("text" in empty, false);
});

test("shape text alignment: centered by default, carried by switch type only where it means something", () => {
  const right = { id: "s", type: "rect", x: 0, y: 0, w: 100, h: 60, fill: "#fff", stroke: "#000", strokeWidth: 1, text: "x", align: "right" };
  assert.equal(switchType(right, "ellipse").align, "right");
  assert.equal(switchType(right, "text").align, "right");
  const centered = { ...right, align: undefined };
  assert.equal(switchType(centered, "text").align, "center");
  const leftText = { id: "t", type: "text", x: 0, y: 0, w: 100, h: 32, text: "x", fontSize: 16, align: "left", color: "#fff" };
  assert.equal("align" in switchType(leftText, "rect"), false);
  assert.equal(switchType({ ...leftText, align: "center" }, "rect").align, "center");
  assert.equal("align" in switchType({ ...right, text: "" }, "diamond"), false);
  assert.deepEqual(styleOf(right), { fill: "#fff", stroke: "#000", strokeWidth: 1, align: "right" });
});
