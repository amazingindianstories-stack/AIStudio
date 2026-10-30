import { MAX_NOTES_REFS, MAX_NOTES_TEXT, MAX_REF_LABEL } from "./extras";

// The board's visual notes: one rich text document for the whole board with links to objects on it.
// Pure helpers; the panel and the store call these. The server stamps who wrote it and when.

export const NOTE_TEMPLATES = [
  { id: "meeting", label: "Meeting notes", text: "Meeting notes\n\nAttendees\n- \n\nDiscussion\n- \n\nDecisions\n- \n\nNext steps\n- " },
  { id: "brief", label: "Creative brief", text: "Creative brief\n\nGoal\n\nAudience\n\nTone and style\n\nMust haves\n- \n\nDeadline" },
  { id: "review", label: "Review checklist", text: "Review checklist\n\n- [ ] Story reads clearly\n- [ ] Characters are consistent\n- [ ] Frames are in order\n- [ ] Open comments are resolved" },
];

function label(node) {
  const raw = node.name || node.text || node.type;
  return String(raw).replace(/\s+/g, " ").trim().slice(0, MAX_REF_LABEL) || node.type;
}

/** `notes` with the typed `text` and `marks` (an empty note with no links is no note). */
export function withNotesText(notes, text, marks) {
  const next = { ...(notes ?? {}), text: text.slice(0, MAX_NOTES_TEXT) };
  if (marks?.length) next.marks = marks;
  else delete next.marks;
  return next.text || next.refs?.length ? next : null;
}

/** `notes` with links to the given board objects added (existing links stay, the list is capped). */
export function withNotesRefs(notes, nodes) {
  const current = notes?.refs ?? [];
  const seen = new Set(current.map((r) => r.id));
  const refs = [...current];
  for (const node of nodes) {
    if (seen.has(node.id) || refs.length >= MAX_NOTES_REFS) continue;
    seen.add(node.id);
    refs.push({ id: node.id, type: node.type, label: label(node) });
  }
  return { ...(notes ?? { text: "" }), refs };
}

/** `notes` without the link to `id`. */
export function withoutNotesRef(notes, id) {
  if (!notes) return null;
  const refs = (notes.refs ?? []).filter((r) => r.id !== id);
  const next = { ...notes };
  if (refs.length) next.refs = refs;
  else delete next.refs;
  return next.text || next.refs ? next : null;
}

/** Links whose object is still on the board, marked live, so deleted objects show as gone rather than dangling. */
export function resolveRefs(notes, nodes) {
  const ids = new Set(nodes.map((n) => n.id));
  return (notes?.refs ?? []).map((ref) => ({ ...ref, live: ids.has(ref.id) }));
}
