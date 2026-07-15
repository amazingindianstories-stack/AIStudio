/**
 * Pure "what actions are valid for the current selection" helper (design.md
 * §Interfaces, spec.md §C "Right-click context menu"). The single shared
 * source of truth for `CanvasContextMenu` (and any future toolbar) — no
 * DOM, no framework, just a read of `CanvasState` + the current selection.
 */
import type { CanvasNode, CanvasState } from "./types";

export interface SelectionActionFlags {
  hasNodeSelection: boolean; // selection.length > 0
  hasConnectorSelection: boolean; // selectedConnectorIds.length > 0
  canDuplicate: boolean; // >= 1 node selected
  canCopy: boolean; // >= 1 node selected
  canPaste: boolean; // clipboardCount > 0
  canDelete: boolean; // >= 1 node OR connector selected
  canReorder: boolean; // >= 1 node selected (bring-to-front / send-to-back)
  canGroup: boolean; // >= 2 nodes selected AND not all sharing one non-null groupId
  canUngroup: boolean; // some selected node has a non-null groupId
}

/** True iff every node shares one identical, non-null groupId. */
function allShareOneGroup(nodes: CanvasNode[]): boolean {
  if (!nodes.length) return false;
  const first = nodes[0].groupId ?? null;
  if (first == null) return false;
  return nodes.every((n) => (n.groupId ?? null) === first);
}

export function selectionActions(
  state: CanvasState,
  selection: string[],
  selectedConnectorIds: string[],
  clipboardCount: number
): SelectionActionFlags {
  const hasNodeSelection = selection.length > 0;
  const hasConnectorSelection = selectedConnectorIds.length > 0;
  const selectedNodes = state.nodes.filter((n) => selection.includes(n.id));

  return {
    hasNodeSelection,
    hasConnectorSelection,
    canDuplicate: hasNodeSelection,
    canCopy: hasNodeSelection,
    canPaste: clipboardCount > 0,
    canDelete: hasNodeSelection || hasConnectorSelection,
    canReorder: hasNodeSelection,
    canGroup: selection.length >= 2 && !allShareOneGroup(selectedNodes),
    canUngroup: selectedNodes.some((n) => n.groupId != null),
  };
}
