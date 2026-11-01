"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import { useCanvasStore, selectReadOnly } from "@/lib/canvas-store";
import { useStore } from "@/lib/store";
import { notify } from "@/lib/notify";
import { onTemplatesRequest } from "@/lib/canvas/template-events";
import { clearSelection, insertTemplate, selectionGraph, templateApi, templateRefFromSearch } from "@/lib/canvas/templates";
import { TemplatePicker } from "./TemplatePicker";
import { SaveTemplateDialog } from "./SaveTemplateDialog";

/** Takes `?template=` off the address once the link has been used, so a reload does not reopen the picker. */
function dropTemplateParam() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("template")) return;
  url.searchParams.delete("template");
  window.history.replaceState(null, "", url);
}

/**
 * Owns everything templates on an open board, so CanvasView only mounts it: the picker (toolbar, tool panels and the
 * `?template=<id>` link open it), saving the board or the selection as a template, the banner on a template's own editing
 * board, and Cmd+Delete, which clears the selected objects' text as one undo step.
 */
export function BoardTemplates({ boardId, projectId, viewCenter, onOpenBoard }) {
  const readOnly = useCanvasStore(selectReadOnly);
  const [picker, setPicker] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);

  // The `?template=<id>` link opens the picker on that template, once.
  useEffect(() => {
    const ref = templateRefFromSearch(window.location.search);
    if (ref) setPicker({ ref });
  }, []);

  useEffect(
    () =>
      onTemplatesRequest((detail) => {
        if (detail.action === "open") setPicker({ tool: detail.tool ?? null, ref: detail.ref ?? null });
        else if (detail.action === "save-board" && boardId && !selectReadOnly(useCanvasStore.getState())) setDialog({ source: { boardId } });
        else if (detail.action === "save-selection") saveSelection();
        else if (detail.action === "scratch") setDialog({ scratch: true });
      }),
    [boardId]
  );

  // Saving the board or part of it needs edit rights on it.
  const saveSelection = () => {
    const state = useCanvasStore.getState();
    if (!state.selection.length || selectReadOnly(state)) return;
    const graph = selectionGraph(state.history.present, state.selection);
    if (graph.nodes.length) setDialog({ source: { graph } });
  };

  // A template's editing board says so, and saves its content back to the template.
  useEffect(() => {
    setEditing(null);
    if (!boardId) return undefined;
    let cancelled = false;
    templateApi.forBoard(boardId).then((r) => !cancelled && setEditing(r.template ?? null), () => {});
    return () => { cancelled = true; };
  }, [boardId]);

  // Cmd+Delete / Ctrl+Delete: clear the selection's content (text, tags, votes) and keep the objects.
  useEffect(() => {
    const onKey = (event) => {
      if (!(event.metaKey || event.ctrlKey) || (event.key !== "Delete" && event.key !== "Backspace")) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const state = useCanvasStore.getState();
      if (!state.selection.length || selectReadOnly(state)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const ids = state.selection;
      state.editBoard((present) => clearSelection(present, ids));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const use = useCallback(
    async (template, blank) => {
      try {
        const full = await templateApi.get(template.id);
        const graph = blank ? full.template.blankGraph : full.template.graph;
        const state = useCanvasStore.getState();
        const result = insertTemplate(state.history.present, graph, viewCenter());
        if (result.tooLarge) {
          notify("This board is too full to add that template. Remove some objects first.");
          return;
        }
        state.editBoard(() => result.next);
        state.setSelection(result.ids);
        void templateApi.use(template.id, boardId).catch(() => {});
        setPicker(null);
        dropTemplateParam();
      } catch (failure) {
        notify(failure.message);
      }
    },
    [boardId, viewCenter]
  );

  const editContent = async (template) => {
    try {
      const result = await templateApi.editBoard(template.id, projectId);
      setPicker(null);
      onOpenBoard(result.boardId, result.projectId);
    } catch (failure) {
      notify(failure.message);
    }
  };

  const saveBack = async () => {
    setSaving(true);
    try {
      await useCanvasStore.getState().flushSave();
      setEditing((await templateApi.update(editing.id, { syncBoard: true })).template);
      notify("Template updated.", { tone: "info" });
    } catch (failure) {
      notify(failure.message);
    }
    setSaving(false);
  };

  return (
    <>
      {editing && !readOnly && editing.canManage && (
        <div role="status" className="pointer-events-auto absolute left-1/2 top-14 z-20 flex -translate-x-1/2 items-center gap-3 rounded-full border border-line bg-ink-700/95 px-4 py-1.5 text-xs text-white shadow-pop">
          Editing template {editing.name}
          <button type="button" disabled={saving} onClick={saveBack} className="inline-flex cursor-pointer items-center gap-1 rounded-full bg-brand px-3 py-1 font-medium text-white disabled:opacity-50">
            {saving && <Loader2 className="h-3 w-3 animate-spin" />} Save to template
          </button>
          <button type="button" onClick={() => setEditing(null)} aria-label="Hide banner" className="cursor-pointer text-white/50 hover:text-white"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}
      {picker && (
        <TemplatePicker
          mode="board"
          projectId={projectId}
          canInsert={Boolean(boardId) && !readOnly}
          initialRef={picker.ref ?? null}
          tool={picker.tool ?? null}
          selectionCount={useCanvasStore.getState().selection.length}
          onUse={use}
          onBlueprintMade={() => setPicker(null)}
          onSaveBoard={() => { setPicker(null); setDialog({ source: { boardId } }); }}
          onSaveSelection={() => { setPicker(null); saveSelection(); }}
          onScratch={() => { setPicker(null); setDialog({ scratch: true }); }}
          onEdit={(template) => { setPicker(null); setDialog({ template }); }}
          onEditContent={editContent}
          onClose={() => { setPicker(null); dropTemplateParam(); }}
        />
      )}
      {dialog && (
        <SaveTemplateDialog
          template={dialog.template}
          source={dialog.source}
          scratch={dialog.scratch}
          projectId={projectId}
          isAdmin={useStore.getState().currentUser?.role === "admin"}
          defaultName={dialog.source?.boardId ? useCanvasStore.getState().boardName ?? "" : ""}
          onClose={() => setDialog(null)}
          onSaved={(template) => {
            setDialog(null);
            notify(dialog.scratch ? "Template created." : "Template saved.", { tone: "info" });
            if (dialog.scratch && template.boardId) onOpenBoard(template.boardId, projectId);
          }}
        />
      )}
    </>
  );
}
