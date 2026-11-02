import assert from "node:assert/strict";
import test from "node:test";
import { emptyCanvasState, validateCanvasState } from "./serialization.js";
import {
  MAX_BOARD_UNITS, TOOL_CATEGORIES, clearSelection, filterTemplates, insertTemplate, readShowPicker, scopeOptions, selectionGraph,
  templateInsertion, templatesForTool, templateLink, templateRefFromSearch, writeShowPicker,
} from "./templates.js";

const base = { parentId: null, groupId: null, x: 0, y: 0, w: 100, h: 100 };
const sticky = (id, extra = {}) => ({ ...base, id, type: "sticky", text: "Note", fill: "#fff59d", fontSize: 16, color: "#000000", ...extra });
const graph = () => ({
  version: 1,
  nodes: [
    { ...base, id: "f", type: "frame", w: 400, h: 300, name: "Frame", fill: "transparent", stroke: "#000000" },
    sticky("a", { x: 20, y: 20, parentId: "f", groupId: "g", tagIds: ["t1", "t2"], reactions: { "+1": ["u"] }, createdBy: "u" }),
    sticky("b", { x: 200, y: 20, parentId: "f", groupId: "g" }),
  ],
  connectors: [{ id: "c", from: { nodeId: "a", anchor: "auto" }, to: { nodeId: "b", anchor: "auto" }, kind: "arrow", stroke: "#000000", strokeWidth: 2 }],
  tags: [{ id: "t1", name: "Idea", color: "#22c55e" }, { id: "t2", name: "Risk", color: "#ef4444" }],
});
const counter = () => { let n = 0; return () => `new-${++n}`; };

test("insertion gives fresh ids and remaps parents, groups, connector ends and tags", () => {
  const present = { ...emptyCanvasState(), tags: [{ id: "x", name: "idea", color: "#000000" }] };
  const added = templateInsertion(present, graph(), { x: 0, y: 0 }, counter());
  const [frame, a, b] = added.nodes;
  assert.equal(a.parentId, frame.id);
  assert.equal(a.groupId, b.groupId);
  assert.notEqual(a.groupId, "g");
  assert.ok(!added.nodes.some((n) => ["f", "a", "b"].includes(n.id)));
  assert.deepEqual([added.connectors[0].from.nodeId, added.connectors[0].to.nodeId], [a.id, b.id]);
  // "Idea" merges into the board's own tag, "Risk" is added.
  assert.equal(a.tagIds[0], "x");
  assert.equal(added.tags.length, 2);
  assert.equal(a.createdBy, undefined);
});

test("insertion centres the template on the viewport centre", () => {
  const added = templateInsertion(emptyCanvasState(), graph(), { x: 1000, y: 500 }, counter());
  const frame = added.nodes[0];
  assert.equal(frame.x + frame.w / 2, 1000);
  assert.equal(frame.y + frame.h / 2, 500);
});

test("inserted boards still validate and two insertions never share an id", () => {
  const first = insertTemplate(emptyCanvasState(), graph(), { x: 0, y: 0 });
  const second = insertTemplate(first.next, graph(), { x: 0, y: 0 });
  assert.equal(second.next.nodes.length, 6);
  assert.equal(new Set(second.next.nodes.map((n) => n.id)).size, 6);
  assert.equal(validateCanvasState(second.next).nodes.length, 6);
  assert.equal(second.tooLarge, false);
});

test("the size check refuses a template that would pass the 2 Mi board cap", () => {
  const huge = { ...emptyCanvasState(), nodes: [sticky("big", { text: "x".repeat(MAX_BOARD_UNITS) })] };
  assert.equal(insertTemplate(huge, graph(), { x: 0, y: 0 }).tooLarge, true);
});

test("format payloads do not count against the board cap and their copies carry no stored reference", () => {
  const text = "x".repeat(18000);
  const docs = Array.from({ length: 4 }, (_, n) => ({ ...base, id: `d${n}`, type: "format", format: "doc", name: "Doc", payload: { size: 1, rev: 1 }, blocks: Array.from({ length: 30 }, (_, b) => ({ id: `b${b}`, type: "p", text })) }));
  const result = insertTemplate(emptyCanvasState(), { ...graph(), nodes: docs }, { x: 0, y: 0 });
  assert.ok(JSON.stringify(result.next).length > MAX_BOARD_UNITS);
  assert.equal(result.tooLarge, false);
  assert.ok(result.next.nodes.every((node) => !("payload" in node) && node.blocks.length === 30));
});

test("clearing a selection clears sticky, text and shape text in one new graph and ignores the rest", () => {
  const present = { ...emptyCanvasState(), nodes: [sticky("a"), { ...base, id: "t", type: "text", text: "Hi", fontSize: 16, align: "left", color: "#000000" }, { ...base, id: "f", type: "frame", name: "Keep", fill: "transparent", stroke: "#000000" }] };
  const next = clearSelection(present, ["a", "t", "f"]);
  assert.deepEqual(next.nodes.map((n) => n.text ?? n.name), ["", "", "Keep"]);
  assert.equal(clearSelection(present, ["f"]), present);
  assert.equal(clearSelection(next, ["a", "t"]), next);
});

test("a selection becomes a graph with its frame children, its internal connectors and its tags", () => {
  const present = { ...emptyCanvasState(), ...graph(), nodes: [...graph().nodes, sticky("z")] };
  present.connectors.push({ id: "c2", from: { nodeId: "a", anchor: "auto" }, to: { nodeId: "z", anchor: "auto" }, kind: "arrow", stroke: "#000000", strokeWidth: 2 });
  const out = selectionGraph(present, ["f"]);
  assert.deepEqual(out.nodes.map((n) => n.id), ["f", "a", "b"]);
  assert.deepEqual(out.connectors.map((c) => c.id), ["c"]);
  assert.deepEqual(out.tags.map((t) => t.id), ["t1", "t2"]);
  assert.equal(out.nodes[1].createdBy, undefined);
  assert.equal(selectionGraph(present, ["z"]).tags, undefined);
});

test("the picker filters by collection, category and search words", () => {
  const items = [
    { id: "1", kind: "builtin", name: "SWOT", description: "Strengths", tags: ["strategy"], category: "strategy-planning", featured: true, collections: ["popular"], uses: 3, liked: true },
    { id: "2", kind: "custom", name: "Retro", description: "", tags: ["team"], category: "agile", featured: false, collections: [], uses: 0 },
    { id: "3", kind: "builtin", name: "Prompt lab", description: "images", tags: [], category: "image-creation", featured: false, collections: ["ai-accelerated", "new"], uses: 0 },
  ];
  const ids = (options) => filterTemplates(items, options).map((t) => t.id);
  assert.deepEqual(ids({}), ["1", "2", "3"]);
  assert.deepEqual(ids({ collection: "featured" }), ["1"]);
  assert.deepEqual(ids({ collection: "ai-accelerated" }), ["3"]);
  assert.deepEqual(ids({ collection: "popular" }), ["1"]);
  assert.deepEqual(ids({ collection: "new" }), ["1", "3"]);
  assert.deepEqual(ids({ category: "agile" }), ["2"]);
  assert.deepEqual(ids({ query: "str  swot" }), ["1"]);
  assert.deepEqual(ids({ mine: true }), ["2"]);
  assert.deepEqual(ids({ collection: "liked" }), ["1"]);
});

test("template links round trip and refuse anything but a template ref", () => {
  assert.equal(templateLink("https://x.test", "builtin:swot"), "https://x.test/?template=builtin%3Aswot");
  assert.equal(templateRefFromSearch("?template=builtin%3Aswot"), "builtin:swot");
  assert.equal(templateRefFromSearch("?template=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(templateRefFromSearch("?template=<script>"), null);
  assert.equal(templateRefFromSearch(""), null);
});

test("the show-picker preference survives a missing or throwing storage", () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.equal(readShowPicker(storage), false);
  writeShowPicker(true, storage);
  assert.equal(readShowPicker(storage), true);
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.equal(readShowPicker(broken), false);
  assert.doesNotThrow(() => writeShowPicker(true, broken));
  assert.equal(readShowPicker(null), false);
});

test("a tool panel shortcut offers the templates of its category", () => {
  const items = [{ id: "1", category: "diagramming" }, { id: "2", category: "agile" }, { id: "3", category: "strategy-planning" }];
  assert.deepEqual(templatesForTool(items, "shapes").map((t) => t.id), ["1"]);
  assert.deepEqual(templatesForTool(items, "frame").map((t) => t.id), ["3"]);
  assert.equal(TOOL_CATEGORIES.shapes, "diagramming");
  assert.equal(templatesForTool(items, "unknown").length, 3);
});

test("access choices offer the open project to its members, everyone to admins, and name an item's own project", () => {
  const labels = (current, viewer) => scopeOptions(current, viewer).map((option) => `${option.id}:${option.label}`);
  assert.deepEqual(labels(null, { projectId: "p", member: true, isAdmin: false }), ["personal:Only me", "project:Everyone in this project"]);
  assert.deepEqual(labels(undefined, { projectId: null, member: false, isAdmin: true }), ["personal:Only me", "everyone:Everyone"]);
  assert.deepEqual(labels({ scope: "project", projectId: "p" }, { projectId: "p", member: true, isAdmin: false }),
    ["personal:Only me", "project:Everyone in this project"]);
  assert.deepEqual(labels({ scope: "project", projectId: "a" }, { projectId: "b", member: true, isAdmin: false }),
    ["personal:Only me", "project:Everyone in its project"]);
  assert.deepEqual(labels({ scope: "everyone", projectId: null }, { projectId: "p", member: false, isAdmin: false }),
    ["personal:Only me", "everyone:Everyone"]);
});
