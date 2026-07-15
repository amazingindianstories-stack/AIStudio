/**
 * Unit tests for src/lib/canvas/selection-actions.ts — the pure "what's
 * valid for this selection" truth table (design.md §Test seams:
 * "selectionActions truth table"). Pure module: no DOM, no network. Run:
 *   npx tsx --test src/lib/canvas/selection-actions.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { selectionActions } from "./selection-actions";
import type { CanvasState, Connector, ShapeNode } from "./types";

function node(id: string, groupId: string | null = null): ShapeNode {
  return {
    id,
    type: "rect",
    x: 0,
    y: 0,
    w: 10,
    h: 10,
    fill: "#fff",
    stroke: "#000",
    strokeWidth: 1,
    parentId: null,
    groupId,
  };
}

function connector(id: string): Connector {
  return {
    id,
    from: { x: 0, y: 0 },
    to: { x: 10, y: 10 },
    kind: "line",
    stroke: "#fff",
    strokeWidth: 1,
  };
}

function state(nodes: ShapeNode[], connectors: Connector[] = []): CanvasState {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes,
    connectors,
  };
}

test("empty selection: every selection-scoped flag is false", () => {
  const flags = selectionActions(state([]), [], [], 0);
  assert.equal(flags.hasNodeSelection, false);
  assert.equal(flags.hasConnectorSelection, false);
  assert.equal(flags.canDuplicate, false);
  assert.equal(flags.canCopy, false);
  assert.equal(flags.canDelete, false);
  assert.equal(flags.canReorder, false);
  assert.equal(flags.canGroup, false);
  assert.equal(flags.canUngroup, false);
  assert.equal(flags.canPaste, false);
});

test("single node selected: duplicate/copy/delete/reorder true, group/ungroup false", () => {
  const s = state([node("A")]);
  const flags = selectionActions(s, ["A"], [], 0);
  assert.equal(flags.hasNodeSelection, true);
  assert.equal(flags.canDuplicate, true);
  assert.equal(flags.canCopy, true);
  assert.equal(flags.canDelete, true);
  assert.equal(flags.canReorder, true);
  assert.equal(flags.canGroup, false, "needs >= 2 nodes");
  assert.equal(flags.canUngroup, false, "no groupId");
});

test("two ungrouped nodes: canGroup true, canUngroup false", () => {
  const s = state([node("A"), node("B")]);
  const flags = selectionActions(s, ["A", "B"], [], 0);
  assert.equal(flags.canGroup, true);
  assert.equal(flags.canUngroup, false);
});

test("two nodes already sharing one group: canGroup false, canUngroup true", () => {
  const s = state([node("A", "g1"), node("B", "g1")]);
  const flags = selectionActions(s, ["A", "B"], [], 0);
  assert.equal(flags.canGroup, false, "already one whole group");
  assert.equal(flags.canUngroup, true);
});

test("mixed grouped/ungrouped selection: canGroup true (not all sharing one group), canUngroup true", () => {
  const s = state([node("A", "g1"), node("B", null)]);
  const flags = selectionActions(s, ["A", "B"], [], 0);
  assert.equal(flags.canGroup, true);
  assert.equal(flags.canUngroup, true);
});

test("two nodes from two DIFFERENT groups: canGroup true (not sharing ONE group), canUngroup true", () => {
  const s = state([node("A", "g1"), node("B", "g2")]);
  const flags = selectionActions(s, ["A", "B"], [], 0);
  assert.equal(flags.canGroup, true);
  assert.equal(flags.canUngroup, true);
});

test("connector-only selection: canDelete true, hasConnectorSelection true, every node-scoped flag false", () => {
  const s = state([node("A")], [connector("c1")]);
  const flags = selectionActions(s, [], ["c1"], 0);
  assert.equal(flags.hasNodeSelection, false);
  assert.equal(flags.hasConnectorSelection, true);
  assert.equal(flags.canDelete, true);
  assert.equal(flags.canDuplicate, false);
  assert.equal(flags.canCopy, false);
  assert.equal(flags.canReorder, false);
  assert.equal(flags.canGroup, false);
  assert.equal(flags.canUngroup, false);
});

test("both a node and a connector selected simultaneously: canDelete true, node-scoped flags reflect the node selection normally", () => {
  const s = state([node("A")], [connector("c1")]);
  const flags = selectionActions(s, ["A"], ["c1"], 0);
  assert.equal(flags.hasNodeSelection, true);
  assert.equal(flags.hasConnectorSelection, true);
  assert.equal(flags.canDelete, true);
  assert.equal(flags.canDuplicate, true);
});

test("clipboardCount 0 vs > 0 drives canPaste, independent of the current selection", () => {
  const s = state([node("A")]);
  assert.equal(selectionActions(s, [], [], 0).canPaste, false);
  assert.equal(selectionActions(s, [], [], 2).canPaste, true);
  assert.equal(selectionActions(s, ["A"], [], 0).canPaste, false);
  assert.equal(selectionActions(s, ["A"], [], 1).canPaste, true);
});

test("unknown id in the selection does not throw", () => {
  const s = state([node("A")]);
  assert.doesNotThrow(() => selectionActions(s, ["A", "nonexistent"], [], 0));
  const flags = selectionActions(s, ["A", "nonexistent"], [], 0);
  assert.equal(flags.hasNodeSelection, true);
  // canGroup is keyed off selection.length (>= 2 raw ids per design.md's rule)
  // even though only "A" resolves to a real node; the lone real node has no
  // groupId, so it can't be "all already sharing one group" either way.
  assert.equal(flags.canGroup, true);
  assert.equal(flags.canUngroup, false, "the one real node has no groupId");
});
