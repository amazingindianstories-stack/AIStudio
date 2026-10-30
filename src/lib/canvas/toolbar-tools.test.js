import assert from "node:assert/strict";
import test from "node:test";
import { CREATION_TOOLS, dockTools, moveTool, orderedTools, pinnedTools, placeToolBefore, togglePinned, toolLabel } from "./toolbar-tools.js";

const DEFAULT = CREATION_TOOLS.map((t) => t.id);

test("the saved order wins, unknown tools drop out and new tools follow in default order", () => {
  assert.deepEqual(orderedTools({}), DEFAULT);
  assert.deepEqual(orderedTools({ toolbarOrder: ["ai", "gone", "text", "ai"] }), ["ai", "text", ...DEFAULT.filter((id) => id !== "ai" && id !== "text")]);
});

test("unpinned tools leave the dock, and only editors get creation tools", () => {
  const prefs = { toolbarHidden: ["frame", "ai"] };
  assert.deepEqual(pinnedTools(prefs), ["sticky", "text", "shapes", "connector", "image"]);
  assert.deepEqual(dockTools(prefs, true).slice(0, 3), ["select", "hand", "sticky"]);
  assert.deepEqual(dockTools(prefs, false), ["select", "hand"]);
});

test("pinning toggles and keeps a stable list", () => {
  assert.deepEqual(togglePinned({ toolbarHidden: ["ai"] }, "frame"), { toolbarHidden: ["frame", "ai"] });
  assert.deepEqual(togglePinned({ toolbarHidden: ["ai"] }, "ai"), { toolbarHidden: [] });
});

test("moving tools by step or by drag", () => {
  assert.deepEqual(moveTool({}, "text", -1).toolbarOrder.slice(0, 2), ["text", "sticky"]);
  assert.deepEqual(moveTool({}, "sticky", -1).toolbarOrder, DEFAULT);
  assert.deepEqual(placeToolBefore({}, "ai", "sticky").toolbarOrder.slice(0, 2), ["ai", "sticky"]);
  assert.equal(placeToolBefore({}, "sticky", null).toolbarOrder.at(-1), "sticky");
});

test("labels", () => {
  assert.equal(toolLabel("select"), "Select");
  assert.equal(toolLabel("ai"), "Create with AI");
});
