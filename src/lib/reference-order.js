/** Occurrence identity is independent of the referenced media bytes or URL. */
export function newReferenceId() {
  return globalThis.crypto?.randomUUID?.() || `ref-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function referenceIdsFor(state) {
  const existing = state.referenceIds || [];
  const seen = new Set();
  return state.referenceImages.map((_, index) => {
    let id = existing[index];
    if (typeof id !== "string" || !id || seen.has(id)) id = newReferenceId();
    seen.add(id);
    return id;
  });
}

export function referencePermutation(state, orderedIds) {
  const ids = referenceIdsFor(state);
  if (!Array.isArray(orderedIds) || orderedIds.length !== ids.length ||
      new Set(orderedIds).size !== ids.length || orderedIds.some(id => !ids.includes(id))) {
    throw new Error("Reference order must contain each occurrence exactly once");
  }
  const positions = new Map(orderedIds.map((id, index) => [id, index]));
  const mapping = ids.map(id => positions.get(id));
  const oldPositions = new Map(ids.map((id, index) => [id, index]));
  const patch = { referenceIds: [...orderedIds] };
  for (const field of ["referenceImages", "referenceKinds", "referenceLabels", "referenceTags"]) {
    patch[field] = orderedIds.map(id => state[field]?.[oldPositions.get(id)] ?? (field === "referenceKinds" ? "image" : ""));
  }
  return { patch, mapping };
}
