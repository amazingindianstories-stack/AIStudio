/**
 * Independent regression/derivation tests for src/lib/canvas/selection-actions.ts
 * (Canvas Board v2, .council/canvas-board-v2/spec.md, design.md "Interfaces
 * (exact signatures)" + "Regression analysis (AC12)").
 *
 * Deliberately a SEPARATE file from whatever `selection-actions.test.ts` the
 * parallel implementer may write — this suite was derived from design.md's
 * interface contract ALONE, without reading selection-actions.ts, so it
 * checks intent rather than mirroring the implementation. Per the task
 * brief, do not merge/overwrite; reconciliation happens after both exist.
 *
 * Contract under test (design.md):
 *
 *   export interface SelectionActionFlags {
 *     hasNodeSelection: boolean;      // selection.length > 0
 *     hasConnectorSelection: boolean; // selectedConnectorIds.length > 0
 *     canDuplicate: boolean;          // >= 1 node selected
 *     canCopy: boolean;                // >= 1 node selected
 *     canPaste: boolean;               // clipboardCount > 0
 *     canDelete: boolean;              // >= 1 node OR connector selected
 *     canReorder: boolean;             // >= 1 node selected
 *     canGroup: boolean;               // >= 2 nodes selected AND not all sharing
 *                                       // one identical non-null groupId
 *     canUngroup: boolean;             // some selected node has groupId != null
 *   }
 *   function selectionActions(
 *     state: CanvasState,
 *     selection: string[],
 *     selectedConnectorIds: string[],
 *     clipboardCount: number
 *   ): SelectionActionFlags;
 *
 * Connector-only selection => everything false except hasConnectorSelection
 * and canDelete (explicit rule called out in design.md).
 *
 * Run: npx tsx --test src/lib/canvas/selection-actions-regression.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { selectionActions } from "./selection-actions";
import type { CanvasNode, CanvasState, Connector, ShapeNode } from "./types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function node(id: string, opts: Partial<ShapeNode> = {}): ShapeNode {
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
    groupId: null,
    ...opts,
  };
}

function connector(id: string): Connector {
  return {
    id,
    from: { x: 0, y: 0 },
    to: { x: 10, y: 10 },
    kind: "line",
    stroke: "#000",
    strokeWidth: 1,
  };
}

function stateWith(nodes: CanvasNode[], connectors: Connector[] = []): CanvasState {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes,
    connectors,
  };
}

// A fully-false baseline to diff against, so every "must be false" assertion
// is explicit rather than relying on omission.
function assertAllFalseExcept(
  flags: ReturnType<typeof selectionActions>,
  truthyKeys: (keyof ReturnType<typeof selectionActions>)[]
) {
  const allKeys: (keyof ReturnType<typeof selectionActions>)[] = [
    "hasNodeSelection",
    "hasConnectorSelection",
    "canDuplicate",
    "canCopy",
    "canPaste",
    "canDelete",
    "canReorder",
    "canGroup",
    "canUngroup",
  ];
  for (const key of allKeys) {
    const expected = truthyKeys.includes(key);
    assert.equal(flags[key], expected, `expected ${key} to be ${expected}, got ${flags[key]}`);
  }
}

// ---------------------------------------------------------------------------
// Empty selection
// ---------------------------------------------------------------------------

test("empty selection, no connectors, empty clipboard: every flag is false", () => {
  const state = stateWith([node("A"), node("B")]);
  const flags = selectionActions(state, [], [], 0);
  assertAllFalseExcept(flags, []);
});

// ---------------------------------------------------------------------------
// Single node selected
// ---------------------------------------------------------------------------

test("single node selected: duplicate/copy/delete/reorder true, group/ungroup false", () => {
  const state = stateWith([node("A"), node("B")]);
  const flags = selectionActions(state, ["A"], [], 0);
  assertAllFalseExcept(flags, [
    "hasNodeSelection",
    "canDuplicate",
    "canCopy",
    "canDelete",
    "canReorder",
  ]);
});

// ---------------------------------------------------------------------------
// Two nodes, grouping states
// ---------------------------------------------------------------------------

test("two nodes selected, neither grouped: canGroup true, canUngroup false", () => {
  const state = stateWith([node("A"), node("B")]);
  const flags = selectionActions(state, ["A", "B"], [], 0);
  assert.equal(flags.canGroup, true);
  assert.equal(flags.canUngroup, false);
  assertAllFalseExcept(flags, [
    "hasNodeSelection",
    "canDuplicate",
    "canCopy",
    "canDelete",
    "canReorder",
    "canGroup",
  ]);
});

test("two nodes selected, both share one identical non-null groupId: canGroup false, canUngroup true", () => {
  const state = stateWith([
    node("A", { groupId: "g1" }),
    node("B", { groupId: "g1" }),
  ]);
  const flags = selectionActions(state, ["A", "B"], [], 0);
  assert.equal(flags.canGroup, false, "already one shared group -- regrouping is not a valid action");
  assert.equal(flags.canUngroup, true);
});

test("two nodes selected with DIFFERENT non-null groupIds (mixed groups): canGroup true (not all sharing ONE group)", () => {
  const state = stateWith([
    node("A", { groupId: "g1" }),
    node("B", { groupId: "g2" }),
  ]);
  const flags = selectionActions(state, ["A", "B"], [], 0);
  assert.equal(
    flags.canGroup,
    true,
    "rule is 'not all sharing one identical non-null groupId' -- two different groupIds do not satisfy 'all share one'"
  );
  assert.equal(flags.canUngroup, true, "at least one selected node has a non-null groupId");
});

test("mixed selection: one grouped node + one ungrouped node -> canGroup true, canUngroup true", () => {
  const state = stateWith([
    node("A", { groupId: "g1" }),
    node("B", { groupId: null }),
  ]);
  const flags = selectionActions(state, ["A", "B"], [], 0);
  assert.equal(flags.canGroup, true);
  assert.equal(flags.canUngroup, true);
});

test("three nodes all sharing one identical groupId: canGroup false, canUngroup true", () => {
  const state = stateWith([
    node("A", { groupId: "g1" }),
    node("B", { groupId: "g1" }),
    node("C", { groupId: "g1" }),
  ]);
  const flags = selectionActions(state, ["A", "B", "C"], [], 0);
  assert.equal(flags.canGroup, false);
  assert.equal(flags.canUngroup, true);
});

// ---------------------------------------------------------------------------
// Connector-only selection
// ---------------------------------------------------------------------------

test("connector-only selection: only hasConnectorSelection and canDelete are true, everything else false", () => {
  const state = stateWith([node("A"), node("B")], [connector("c1")]);
  const flags = selectionActions(state, [], ["c1"], 0);
  assertAllFalseExcept(flags, ["hasConnectorSelection", "canDelete"]);
  // Explicit call-outs per the brief, in case assertAllFalseExcept's loop
  // logic itself has a bug -- verify the key ones individually too.
  assert.equal(flags.canDuplicate, false);
  assert.equal(flags.canCopy, false);
  assert.equal(flags.canGroup, false);
  assert.equal(flags.canUngroup, false);
  assert.equal(flags.canReorder, false);
  assert.equal(flags.hasNodeSelection, false);
});

test("multiple connectors selected, no nodes: still only hasConnectorSelection/canDelete true", () => {
  const state = stateWith([node("A")], [connector("c1"), connector("c2")]);
  const flags = selectionActions(state, [], ["c1", "c2"], 0);
  assertAllFalseExcept(flags, ["hasConnectorSelection", "canDelete"]);
});

// ---------------------------------------------------------------------------
// Clipboard / paste
// ---------------------------------------------------------------------------

test("clipboardCount 0: canPaste is false regardless of selection", () => {
  const state = stateWith([node("A")]);
  const flagsEmptySel = selectionActions(state, [], [], 0);
  const flagsWithSel = selectionActions(state, ["A"], [], 0);
  assert.equal(flagsEmptySel.canPaste, false);
  assert.equal(flagsWithSel.canPaste, false);
});

test("clipboardCount > 0: canPaste is true even with an empty selection (paste does not require a selection)", () => {
  const state = stateWith([node("A")]);
  const flags = selectionActions(state, [], [], 1);
  assert.equal(flags.canPaste, true);
  // Nothing else should spuriously flip true just because clipboard has content.
  assertAllFalseExcept(flags, ["canPaste"]);
});

test("clipboardCount > 0 combined with a node selection: canPaste true, independent of other flags", () => {
  const state = stateWith([node("A"), node("B")]);
  const flags = selectionActions(state, ["A"], [], 3);
  assert.equal(flags.canPaste, true);
  assert.equal(flags.canDuplicate, true);
  assert.equal(flags.canCopy, true);
});

test("large clipboardCount (e.g. 2) behaves identically to clipboardCount 1 for canPaste", () => {
  const state = stateWith([node("A")]);
  const flags1 = selectionActions(state, [], [], 1);
  const flags2 = selectionActions(state, [], [], 2);
  assert.equal(flags1.canPaste, true);
  assert.equal(flags2.canPaste, true);
});

// ---------------------------------------------------------------------------
// Simultaneous node + connector selection
// ---------------------------------------------------------------------------

test("simultaneous node and connector selection: node-based flags reflect the node selection normally", () => {
  const state = stateWith([node("A"), node("B")], [connector("c1")]);
  const flags = selectionActions(state, ["A", "B"], ["c1"], 0);
  assert.equal(flags.hasNodeSelection, true);
  assert.equal(flags.hasConnectorSelection, true);
  assert.equal(flags.canDuplicate, true, "duplicate is node-based -- 2 nodes selected");
  assert.equal(flags.canCopy, true, "copy is node-based -- 2 nodes selected");
  assert.equal(flags.canReorder, true, "reorder is node-based -- 2 nodes selected");
  assert.equal(flags.canDelete, true, "delete is true because node OR connector selected");
  assert.equal(flags.canGroup, true, "2 ungrouped nodes selected -- group is independent of connector selection");
});

test("simultaneous single node + connector selection: canGroup false (needs >=2 nodes) even though something is selected", () => {
  const state = stateWith([node("A")], [connector("c1")]);
  const flags = selectionActions(state, ["A"], ["c1"], 0);
  assert.equal(flags.canGroup, false, "only 1 node selected -- group requires >= 2 regardless of connector selection");
  assert.equal(flags.canDelete, true);
  assert.equal(flags.hasConnectorSelection, true);
});

// ---------------------------------------------------------------------------
// canDelete boundary: node-only, connector-only, both, neither
// ---------------------------------------------------------------------------

test("canDelete is true for node-only selection", () => {
  const state = stateWith([node("A")]);
  assert.equal(selectionActions(state, ["A"], [], 0).canDelete, true);
});

test("canDelete is false when nothing at all is selected", () => {
  const state = stateWith([node("A")], [connector("c1")]);
  assert.equal(selectionActions(state, [], [], 0).canDelete, false);
});

// ---------------------------------------------------------------------------
// Unknown / stale ids in selection (defensive -- selection can reference an
// id no longer present in state.nodes, e.g. after an out-of-band delete)
// ---------------------------------------------------------------------------

test("selection referencing an id not present in state.nodes does not throw", () => {
  const state = stateWith([node("A")]);
  assert.doesNotThrow(() => selectionActions(state, ["ghost"], [], 0));
});

test("does not mutate the input state, selection, or connector-id arrays", () => {
  const state = stateWith([node("A", { groupId: "g1" }), node("B", { groupId: "g1" })]);
  const nodesSnapshot = JSON.stringify(state.nodes);
  const selection = ["A", "B"];
  const selectedConnectorIds: string[] = [];
  selectionActions(state, selection, selectedConnectorIds, 0);
  assert.equal(JSON.stringify(state.nodes), nodesSnapshot);
  assert.deepEqual(selection, ["A", "B"]);
  assert.deepEqual(selectedConnectorIds, []);
});
