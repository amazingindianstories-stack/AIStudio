

/** True iff every node shares one identical, non-null groupId. */
function allShareOneGroup(nodes) {
  if (!nodes.length) return false;
  const first = nodes[0].groupId ?? null;
  if (first == null) return false;
  return nodes.every((n) => (n.groupId ?? null) === first);
}

export function selectionActions(
  state,
  selection,
  selectedConnectorIds,
  clipboardCount
) {
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
