"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, X } from "lucide-react";
import { TEMPLATE_CATEGORY_LABELS, scopeOptions, templateApi } from "@/lib/canvas/templates";
import { fetchProjectAccess } from "@/lib/board-access";

const field =
  "w-full rounded-lg border border-line bg-ink-700 px-3 py-2 text-sm text-white outline-none transition placeholder:text-white/30 focus:border-white/25 focus:ring-2 focus:ring-white/10";

/**
 * Names and shares a template: saving the whole board, the selection, a new template from scratch, or editing the details of
 * an existing one (`template`). `source` is `{ boardId }` or `{ boardId, graph }` for a selection; `scratch` makes an empty template edited on its own board.
 * Only an admin shares with everyone and only a project member with the project, so the other choices are not offered; editing
 * details sends the access only when it changes, so a template never moves to the project that happens to be open.
 */
export function SaveTemplateDialog({ template, source, scratch = false, projectId, isAdmin, defaultName = "", onClose, onSaved }) {
  const titleId = useId();
  const nameRef = useRef(null);
  const [name, setName] = useState(template?.name ?? defaultName);
  const [description, setDescription] = useState(template?.description ?? "");
  const [category, setCategory] = useState(template?.category ?? "other");
  const [tags, setTags] = useState((template?.tags ?? []).join(", "));
  const [scope, setScope] = useState(template?.scope ?? "personal");
  const [featured, setFeatured] = useState(Boolean(template?.featured));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [member, setMember] = useState(false);

  useEffect(() => nameRef.current?.focus(), []);
  useEffect(() => {
    if (!projectId) return undefined;
    let cancelled = false;
    fetchProjectAccess(projectId).then((access) => !cancelled && setMember(Boolean(access.role)), () => {});
    return () => { cancelled = true; };
  }, [projectId]);
  const scopes = scopeOptions(template, { projectId, member, isAdmin });

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const details = {
      name, description, category,
      ...(!template || scope !== template.scope ? { scope, projectId } : {}),
      tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
      ...(isAdmin ? { featured } : {}),
    };
    try {
      const result = template
        ? await templateApi.update(template.id, details)
        : await templateApi.create({ ...details, ...(scratch ? { fromScratch: true } : source) });
      onSaved(result.template);
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  };

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[210] grid place-items-center bg-black/55 p-4" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={submit}
        onKeyDown={(event) => event.key === "Escape" && (event.stopPropagation(), onClose())}
        className="flex max-h-[88dvh] w-full max-w-[32rem] flex-col overflow-hidden rounded-2xl border border-line bg-ink-750 shadow-pop"
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 id={titleId} className="text-sm font-semibold text-white">
            {template ? "Edit template details" : scratch ? "Create a template" : "Save as template"}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-white/50 hover:bg-white/10 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="scroll-thin flex flex-col gap-3 overflow-y-auto px-5 py-4">
          <label className="flex flex-col gap-1 text-xs text-white/60">
            Name
            <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} className={field} placeholder="Weekly planning" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-white/60">
            Description
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={1000} className={field} placeholder="What it is for" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-xs text-white/60">
              Category
              <select value={category} onChange={(e) => setCategory(e.target.value)} className={field}>
                {Object.entries(TEMPLATE_CATEGORY_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-white/60">
              Who can use it
              <select value={scope} onChange={(e) => setScope(e.target.value)} className={field}>
                {scopes.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
          </div>
          <label className="flex flex-col gap-1 text-xs text-white/60">
            Tags (separate with commas)
            <input value={tags} onChange={(e) => setTags(e.target.value)} className={field} placeholder="planning, team" />
          </label>
          {isAdmin && (
            <label className="flex items-center gap-2 text-xs text-white/70">
              <input type="checkbox" checked={featured} onChange={(e) => setFeatured(e.target.checked)} /> Feature this template for everyone
            </label>
          )}
          {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <button type="button" onClick={onClose} className="cursor-pointer rounded-lg px-3 py-1.5 text-xs text-white/70 hover:bg-white/10">Cancel</button>
          <button type="submit" disabled={busy || !name.trim()} className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-ink-950 disabled:cursor-not-allowed disabled:opacity-50">
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {template ? "Save details" : scratch ? "Create and open" : "Save template"}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}
