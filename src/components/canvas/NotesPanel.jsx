"use client";

import { useEffect, useState } from "react";
import { FileText, Bold, Italic, Link2, Pin, PinOff, Underline, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCanvasStore, selectReadOnly } from "@/lib/canvas-store";
import { useNotesPanel } from "@/lib/notes-panel";
import { displayName } from "@/lib/board-access";
import { usePeople } from "@/lib/canvas/use-people";
import { NOTE_TEMPLATES, resolveRefs, withNotesRefs, withNotesText, withoutNotesRef } from "@/lib/canvas/notes";
import { MAX_NOTES_TEXT } from "@/lib/canvas/extras";
import { toggleFormat } from "@/lib/canvas/rich-text-commands";
import { RichTextContent, RichTextEditor } from "./nodes/RichText";

function setNotes(next) {
  useCanvasStore.getState().editBoard((graph) => {
    const { notes: _old, ...rest } = graph;
    return next ? { ...rest, notes: next } : rest;
  });
}

function focusObject(id) {
  const store = useCanvasStore.getState();
  const node = store.history.present.nodes.find((n) => n.id === id);
  if (!node) return;
  store.setSelection([id]);
  const vp = store.history.present.viewport;
  store.setViewport({ ...vp, x: node.x + node.w / 2 - 400 / vp.zoom, y: node.y + node.h / 2 - 300 / vp.zoom });
}

/**
 * Visual notes for the whole board: formatted text, templates, links to objects and who wrote it last.
 * Everyone who can open the board reads it; only people who can edit change it.
 */
export function NotesPanel() {
  const open = useNotesPanel((s) => s.open);
  const pinned = useNotesPanel((s) => s.pinned);
  const hydrate = useNotesPanel((s) => s.hydrate);
  const people = usePeople();
  const readOnly = useCanvasStore(selectReadOnly);
  const notes = useCanvasStore((s) => s.history.present.notes ?? null);
  const nodes = useCanvasStore((s) => s.history.present.nodes);
  const selection = useCanvasStore((s) => s.selection);
  const [editing, setEditing] = useState(false);

  useEffect(() => hydrate(), [hydrate]);
  useEffect(() => {
    if (!open) setEditing(false);
  }, [open]);

  if (!open) return null;
  const refs = resolveRefs(notes, nodes);
  const picked = nodes.filter((n) => selection.includes(n.id));
  const stamp = notes?.updatedAt ? new Date(notes.updatedAt).toLocaleString() : null;

  return (
    <aside
      aria-label="Board notes"
      className="pointer-events-auto absolute bottom-20 right-3 top-16 z-20 flex w-[320px] max-w-[calc(100%-24px)] flex-col rounded-xl border border-line bg-ink-750/95 text-sm text-white/85 shadow-pop"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <header className="flex items-center gap-1 border-b border-line px-3 py-2">
        <h2 className="flex-1 text-sm font-semibold text-white">Notes</h2>
        <button
          type="button"
          aria-label={pinned ? "Unpin notes" : "Keep notes open"}
          aria-pressed={pinned}
          title={pinned ? "Unpin notes" : "Keep notes open on this board"}
          onClick={() => useNotesPanel.getState().setPinned(!pinned)}
          className="grid h-7 w-7 place-items-center rounded hover:bg-white/10"
        >
          {pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
        </button>
        <button type="button" aria-label="Close notes" onClick={() => useNotesPanel.getState().close()} className="grid h-7 w-7 place-items-center rounded hover:bg-white/10">
          <X className="h-4 w-4" />
        </button>
      </header>

      {editing && !readOnly && (
        <div data-rich-format="" role="group" aria-label="Text formatting" className="flex gap-0.5 border-b border-line px-2 py-1">
          {[["b", Bold, "Bold"], ["i", Italic, "Italic"], ["u", Underline, "Underline"]].map(([kind, Icon, name]) => (
            <button key={kind} type="button" aria-label={name} title={name} onMouseDown={(e) => e.preventDefault()} onClick={() => toggleFormat(kind)} className="grid h-7 w-7 place-items-center rounded hover:bg-white/10">
              <Icon className="h-4 w-4" />
            </button>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {editing && !readOnly ? (
          <RichTextEditor
            text={notes?.text ?? ""}
            marks={notes?.marks}
            maxLength={MAX_NOTES_TEXT}
            className="min-h-[160px] whitespace-pre-wrap break-words outline-none"
            onCommit={(text, marks) => {
              setEditing(false);
              const next = withNotesText(notes, text, marks);
              if (JSON.stringify(next) !== JSON.stringify(notes)) setNotes(next);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : notes?.text ? (
          <div className="whitespace-pre-wrap break-words" onDoubleClick={() => !readOnly && setEditing(true)}>
            <RichTextContent text={notes.text} marks={notes.marks} openLinks />
          </div>
        ) : (
          <div className="space-y-2 text-white/55">
            <p>No notes yet.</p>
            {!readOnly && (
              <div className="flex flex-wrap gap-1.5">
                {NOTE_TEMPLATES.map((t) => (
                  <button key={t.id} type="button" onClick={() => { setNotes(withNotesText(notes, t.text, [])); setEditing(true); }} className="rounded-md bg-white/10 px-2 py-1 text-xs text-white/80 hover:bg-white/15">
                    {t.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {refs.length > 0 && (
          <ul aria-label="Linked objects" className="mt-3 space-y-1 border-t border-line pt-2">
            {refs.map((ref) => (
              <li key={ref.id} className="flex items-center gap-1">
                <button type="button" disabled={!ref.live} onClick={() => focusObject(ref.id)} className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-white/10 disabled:opacity-50">
                  <Link2 className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{ref.label || ref.type}</span>
                  {!ref.live && <span className="text-xs text-white/40">(removed)</span>}
                </button>
                {!readOnly && (
                  <button type="button" aria-label={`Unlink ${ref.label || ref.type}`} onClick={() => setNotes(withoutNotesRef(notes, ref.id))} className="grid h-6 w-6 place-items-center rounded hover:bg-white/10">
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="flex items-center gap-2 border-t border-line px-3 py-2 text-xs text-white/50">
        <span className="min-w-0 flex-1 truncate">{notes?.updatedBy && stamp ? `Last edited by ${displayName(people.get(notes.updatedBy), notes.updatedBy)}, ${stamp}` : "Double-click the text to edit"}</span>
        {!readOnly && (
          <>
            <button type="button" disabled={picked.length === 0} title="Link the selected objects" onClick={() => setNotes(withNotesRefs(notes, picked))} className="rounded bg-white/10 px-2 py-1 text-white/80 hover:bg-white/15 disabled:opacity-40">
              Link selection
            </button>
            {!editing && (
              <button type="button" onClick={() => setEditing(true)} className="rounded bg-white/10 px-2 py-1 text-white/80 hover:bg-white/15">
                Edit
              </button>
            )}
          </>
        )}
      </footer>
    </aside>
  );
}

/** The toolbar button that opens and closes the notes panel. */
export function NotesButton() {
  const open = useNotesPanel((s) => s.open);
  return (
    <button
      type="button"
      className={cn(
        "grid h-9 w-9 cursor-pointer place-items-center rounded-lg transition-colors max-sm:h-8 max-sm:w-8",
        open ? "bg-ink-600 text-white ring-1 ring-line" : "text-white/55 hover:bg-white/[0.07] hover:text-white"
      )}
      title="Board notes"
      aria-label="Board notes"
      aria-pressed={open}
      onClick={() => useNotesPanel.getState().toggle()}
    >
      <FileText className="h-4 w-4" />
    </button>
  );
}
