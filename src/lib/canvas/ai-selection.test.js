import assert from "node:assert/strict";
import test from "node:test";
import { LANGUAGES, SELECTION_ACTIONS, actionApplies, contextFields, nodeText, selectionContext, toneAction, translateAction } from "./ai-selection.js";

const nodes = [
  { id: "a", type: "sticky", text: " hello " },
  { id: "b", type: "frame", name: "Plan" },
  { id: "c", type: "image", src: "/api/media/x.png", alt: "lamp" },
  { id: "d", type: "image", src: "https://elsewhere.example/x.png" },
  { id: "e", type: "sticky", text: "   " },
  { id: "f", type: "sticky", text: "unselected" },
];

test("the selection is read from the data model: text-bearing objects and board images", () => {
  const context = selectionContext(nodes, ["a", "b", "c", "d", "e"]);
  assert.deepEqual(context.items.map((item) => [item.id, item.text]), [["a", "hello"], ["b", "Plan"]]);
  assert.deepEqual(context.images, [{ id: "c", src: "/api/media/x.png", alt: "lamp" }]);
  assert.equal(context.count, 5);
  assert.equal(nodeText({ type: "line" }), "");
});

test("a long text is cut and the item count is capped", () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ id: `n${i}`, type: "sticky", text: "x".repeat(3000) }));
  const context = selectionContext(many, many.map((node) => node.id));
  assert.equal(context.items.length, 60);
  assert.equal(context.items[0].text.length, 2000);
});

test("context fields: text context for text formats, reference images for an image", () => {
  const context = selectionContext(nodes, ["a", "c"]);
  assert.deepEqual(contextFields("rewrite", context), { context: context.items });
  assert.deepEqual(contextFields("image", context), { referenceImages: ["/api/media/x.png"] });
  assert.deepEqual(contextFields("image", selectionContext(nodes, ["a"])), {});
  assert.deepEqual(contextFields("stickies", selectionContext(nodes, ["c"])), {});
});

test("actions apply only when the selection has what they need", () => {
  const cluster = SELECTION_ACTIONS.find((action) => action.format === "cluster");
  const rewrite = SELECTION_ACTIONS.find((action) => action.format === "rewrite");
  assert.equal(actionApplies(rewrite, selectionContext(nodes, ["c"]), nodes), false);
  assert.equal(actionApplies(rewrite, selectionContext(nodes, ["b"]), nodes), true);
  assert.equal(actionApplies(cluster, selectionContext(nodes, ["b"]), nodes), false, "frames are not stickies");
  assert.equal(actionApplies(cluster, selectionContext(nodes, ["a"]), nodes), true);
  assert.match(translateAction("French").prompt, /French/);
  assert.match(toneAction("Fun").prompt, /fun/);
  assert.ok(LANGUAGES.length >= 10);
});
