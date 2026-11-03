import assert from "node:assert/strict";
import test from "node:test";
import {
  LANGUAGES, SELECTION_ACTIONS, actionApplies, contextFields, isRecolorRequest, nodeText, recolorAction, selectionContext, toneAction, translateAction,
} from "./ai-selection.js";

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
  const recolor = recolorAction("black");
  assert.deepEqual([recolor.format, /black/.test(recolor.prompt)], ["recolor", true]);
  assert.equal(actionApplies(recolor, selectionContext(nodes, ["b"]), nodes), false, "frames are not recoloured");
  assert.equal(actionApplies(recolor, selectionContext(nodes, ["a"]), nodes), true);
  assert.equal(actionApplies(recolor, selectionContext(nodes, ["e"]), nodes), true, "a blank note can be recoloured");
  assert.ok(LANGUAGES.length >= 10);
});

test("a recolour reaches every selected note and shape, blank ones too, and never frames or images", () => {
  const board = [...nodes, { id: "r", type: "rect", fill: "#fff" }, { id: "t", type: "text", text: "title" }];
  const context = selectionContext(board, ["a", "b", "c", "e", "r", "t"]);
  assert.deepEqual(context.colorable, [{ id: "a", type: "sticky", text: "hello" }, { id: "e", type: "sticky", text: "" }, { id: "r", type: "rect", text: "" }]);
  assert.deepEqual(contextFields("recolor", context), { context: context.colorable });
  assert.deepEqual(contextFields("recolor", selectionContext(board, ["b", "t"])), {});
});

test("a typed request to recolour the selection is recognised, and other requests are not", () => {
  for (const prompt of ["make these notes black", "Make these notes #ff00aa", "change the colour of these notes to black", "turn them black.",
    "colour the selected notes grey", "Recolor them by sentiment", "please make all the notes dark blue", "set their color to teal",
    "change the colour of the notes to teal", "change these notes to black", "make these black", "recolour these by sentiment",
    "change the colour of these to #00ff88", "Make the selected sticky notes light grey", "change the notes colour to black",
    "change the note colors to black", "change the colour to black", "make it black", "make this black", "change it to black",
    "Can you make these notes black?", "make these notes black please", "make them black please", "make these notes navy", "make these notes #fff",
    "change the colour to mauve", "change the colour to dark blue"]) {
    assert.equal(isRecolorRequest(prompt), true, prompt);
  }
  for (const prompt of ["Three black sticky notes with shot ideas", "make the background black", "turn these notes into a flowchart in black",
    "a cat", "Make a diagram of colour grading steps", "Questions to ask before a location scout", "Shot ideas where the lights change colour",
    "A set of shot ideas using a warm colour palette", "Flowchart of how to set the colour balance on set", "Ideas for how to recolour the film in post",
    "Expand these into a colour script: switch from cold to warm colours by act", "make it black and white", "make these images black and white",
    "colour these images sepia", "change the colour of these frames to black",
    "change the colour to black and white", "change the colour to sepia", "change the colours to a warmer grade", "set the colour to match the poster"]) {
    assert.equal(isRecolorRequest(prompt), false, prompt);
  }
});
