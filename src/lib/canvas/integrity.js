/**
 * Graph integrity shared by validation and the three-way merge: unique ids and an acyclic frame
 * hierarchy. Pure, never throws, and returns the same arrays and objects when nothing needs repair.
 */

/** `items` without later duplicates of an id; the first one wins. */
export function dropDuplicateIds(items) {
  const seen = new Set();
  let clean = true;
  const kept = items.filter((item) => {
    if (seen.has(item.id)) {
      clean = false;
      return false;
    }
    seen.add(item.id);
    return true;
  });
  return clean ? items : kept;
}

/**
 * `nodes` with every parent cycle (A inside B inside A, or a node inside itself) broken: the
 * `parentId` that closes the loop, found from the earliest node in the list, becomes null.
 */
export function breakParentCycles(nodes) {
  const parent = new Map();
  for (const node of nodes) if (node.parentId) parent.set(node.id, node.parentId);
  const acyclic = new Set();
  const cut = new Set();
  for (const node of nodes) {
    if (acyclic.has(node.id)) continue;
    const walked = new Set([node.id]);
    let at = parent.get(node.id);
    let loopsBack = false;
    while (at !== undefined && !acyclic.has(at)) {
      if (at === node.id) {
        loopsBack = true;
        break;
      }
      // A cycle that does not include this node is cut when its own member comes up.
      if (walked.has(at)) break;
      walked.add(at);
      at = parent.get(at);
    }
    if (loopsBack) {
      parent.delete(node.id);
      cut.add(node.id);
    }
    // The chain from this node is now known to end; a chain into someone else's cycle is not.
    if (loopsBack || at === undefined || acyclic.has(at)) for (const id of walked) acyclic.add(id);
  }
  return cut.size ? nodes.map((node) => (cut.has(node.id) ? { ...node, parentId: null } : node)) : nodes;
}
