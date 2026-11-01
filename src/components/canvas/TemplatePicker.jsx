"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Heart, Link2, Loader2, Pencil, Plus, Search, Send, Star, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  TEMPLATE_CATEGORY_LABELS, TEMPLATE_COLLECTIONS, filterTemplates, readShowPicker, templateApi, templateLink,
  templatesForTool, writeShowPicker,
} from "@/lib/canvas/templates";
import { TemplateThumb } from "./TemplateThumb";
import { BlueprintsTab, InsightsTab } from "./TemplateExtras";

const SCOPE_LABELS = { personal: "Only me", project: "Project", everyone: "Everyone" };

function Card({ template, active, onSelect }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(template.id)}
      aria-pressed={active}
      aria-label={template.name}
      className={cn(
        "flex cursor-pointer flex-col overflow-hidden rounded-xl border bg-ink-700 text-left transition hover:border-white/25",
        active ? "border-white/40 ring-2 ring-white/15" : "border-line"
      )}
    >
      <div className="aspect-[4/3] w-full bg-ink-800 p-2"><TemplateThumb preview={template.preview} /></div>
      <div className="flex flex-col gap-0.5 px-3 py-2">
        <span className="truncate text-xs font-medium text-white">{template.name}</span>
        <span className="truncate text-[11px] text-white/45">
          {template.featured && "Featured · "}{TEMPLATE_CATEGORY_LABELS[template.category]}
        </span>
      </div>
    </button>
  );
}

function Detail({ template, mode, canInsert, isAdmin, onUse, onChanged, onEdit, onEditContent, onDelete }) {
  const [blank, setBlank] = useState(false);
  const [comments, setComments] = useState(null);
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState("");
  const ref = template.id;

  useEffect(() => {
    let cancelled = false;
    setComments(null);
    setBlank(false);
    templateApi.comments(ref).then((r) => !cancelled && setComments(r.comments), () => !cancelled && setComments([]));
    return () => { cancelled = true; };
  }, [ref]);

  const like = async () => {
    try {
      const result = await templateApi.like(ref, !template.liked);
      onChanged({ ...template, liked: result.liked, likes: result.likes });
    } catch (failure) { setNote(failure.message); }
  };
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(templateLink(window.location.origin, ref));
      setNote("Link copied.");
    } catch { setNote("Could not copy the link."); }
  };
  const send = async (event) => {
    event.preventDefault();
    if (!draft.trim()) return;
    try {
      const result = await templateApi.addComment(ref, draft);
      setComments(result.comments);
      onChanged({ ...template, commentCount: result.comments.length });
      setDraft("");
    } catch (failure) { setNote(failure.message); }
  };
  const feature = async () => {
    try { onChanged((await templateApi.update(ref, { featured: !template.featured })).template); } catch (failure) { setNote(failure.message); }
  };

  return (
    <div className="flex min-h-0 flex-col gap-3 overflow-y-auto scroll-thin p-5" data-testid="template-detail">
      <div className="aspect-[4/3] w-full rounded-xl border border-line bg-ink-800 p-3"><TemplateThumb preview={template.preview} /></div>
      <div>
        <h3 className="text-sm font-semibold text-white">{template.name}</h3>
        <p className="mt-0.5 text-[11px] text-white/45">
          {template.author} · {template.nodeCount} objects · {SCOPE_LABELS[template.scope]} · used {template.uses} {template.uses === 1 ? "time" : "times"}
        </p>
        {template.description && <p className="mt-2 text-xs leading-5 text-white/70">{template.description}</p>}
        {template.tags.length > 0 && <p className="mt-1 text-[11px] text-white/40">{template.tags.map((tag) => `#${tag}`).join(" ")}</p>}
      </div>
      <div role="radiogroup" aria-label="Start with" className="grid grid-cols-2 gap-1 rounded-lg border border-line bg-ink-800 p-1 text-xs">
        {[["Pre-filled", false], ["Blank", true]].map(([label, value]) => (
          <button key={label} type="button" role="radio" aria-checked={blank === value} onClick={() => setBlank(value)}
            className={cn("cursor-pointer rounded-md px-2 py-1.5", blank === value ? "bg-ink-600 text-white" : "text-white/55 hover:text-white")}>
            {label}
          </button>
        ))}
      </div>
      <button type="button" disabled={!canInsert} onClick={() => onUse(template, blank)}
        className="cursor-pointer rounded-lg bg-brand px-3 py-2 text-xs font-medium text-ink-950 disabled:cursor-not-allowed disabled:opacity-50">
        {mode === "new" ? "Create board from template" : "Add to board"}
      </button>
      {!canInsert && <p className="text-[11px] text-white/45">You can only view this board, so templates cannot be added.</p>}
      <div className="flex flex-wrap gap-1.5 text-xs text-white/70">
        <button type="button" onClick={like} aria-pressed={template.liked} className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-line px-2 py-1 hover:bg-white/10">
          <Heart className={cn("h-3.5 w-3.5", template.liked && "fill-red-400 text-red-400")} /> {template.likes}
        </button>
        <button type="button" onClick={copyLink} className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-line px-2 py-1 hover:bg-white/10"><Link2 className="h-3.5 w-3.5" /> Copy link</button>
        {isAdmin && <button type="button" onClick={feature} className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-line px-2 py-1 hover:bg-white/10"><Star className={cn("h-3.5 w-3.5", template.featured && "fill-yellow-300 text-yellow-300")} /> {template.featured ? "Unfeature" : "Feature"}</button>}
        {template.canManage && (
          <>
            {onEdit && <button type="button" onClick={() => onEdit(template)} className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-line px-2 py-1 hover:bg-white/10"><Pencil className="h-3.5 w-3.5" /> Edit details</button>}
            {onEditContent && <button type="button" onClick={() => onEditContent(template)} className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-line px-2 py-1 hover:bg-white/10">Edit content</button>}
            <button type="button" onClick={() => onDelete(template)} className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-line px-2 py-1 text-red-300 hover:bg-red-500/10"><Trash2 className="h-3.5 w-3.5" /> Delete</button>
          </>
        )}
      </div>
      {note && <p role="status" className="text-[11px] text-white/55">{note}</p>}
      <div className="border-t border-line pt-3">
        <h4 className="text-xs font-medium text-white/80">Feedback ({comments?.length ?? template.commentCount})</h4>
        {comments === null ? <Loader2 className="mt-2 h-3.5 w-3.5 animate-spin text-white/40" /> : (
          <ul className="mt-2 flex flex-col gap-2">
            {comments.map((comment) => (
              <li key={comment.id} className="text-xs text-white/70"><span className="text-white/45">{comment.author}: </span>{comment.body}</li>
            ))}
          </ul>
        )}
        <form onSubmit={send} className="mt-2 flex gap-1.5">
          <input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={1000} placeholder="Leave feedback" aria-label="Leave feedback"
            className="min-w-0 flex-1 rounded-lg border border-line bg-ink-700 px-2.5 py-1.5 text-xs text-white outline-none placeholder:text-white/30 focus:border-white/25" />
          <button type="submit" disabled={!draft.trim()} aria-label="Send feedback" className="grid h-8 w-8 cursor-pointer place-items-center rounded-lg bg-ink-600 text-white disabled:opacity-40"><Send className="h-3.5 w-3.5" /></button>
        </form>
      </div>
    </div>
  );
}

/**
 * The template picker (Miro's template picker): search, collections, categories, a preview with a pre-filled or blank
 * start, and custom templates with their likes, feedback and sharing link. `mode` is `board` (add to the open board) or
 * `new` (start a new board). Blueprints (a project with several boards) and the admin's usage insights are tabs.
 */
export function TemplatePicker({
  mode = "board", projectId, canInsert = true, initialRef = null, tool = null, selectionCount = 0,
  onUse, onSaveBoard, onSaveSelection, onScratch, onBlank, onEdit, onEditContent, onClose, onBlueprintMade,
}) {
  const titleId = useId();
  const searchRef = useRef(null);
  const [tab, setTab] = useState("templates");
  const [templates, setTemplates] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [collection, setCollection] = useState("all");
  const [category, setCategory] = useState("all");
  const [mine, setMine] = useState(false);
  const [selected, setSelected] = useState(initialRef);
  const [showPicker, setShowPicker] = useState(() => readShowPicker());
  const [undo, setUndo] = useState(null);

  const load = useCallback(async () => {
    try {
      const result = await templateApi.list(projectId);
      setTemplates(result.templates);
      setIsAdmin(result.isAdmin);
    } catch (failure) { setError(failure.message); }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => searchRef.current?.focus(), []);
  useEffect(() => {
    if (!undo) return undefined;
    const timer = setTimeout(() => setUndo(null), 8000);
    return () => clearTimeout(timer);
  }, [undo]);

  const scoped = useMemo(() => (templates && tool ? templatesForTool(templates, tool) : templates ?? []), [templates, tool]);
  const shown = useMemo(() => filterTemplates(scoped, { query, category, collection, mine }), [scoped, query, category, collection, mine]);
  const current = templates?.find((item) => item.id === selected) ?? null;
  const patch = (next) => setTemplates((list) => list.map((item) => (item.id === next.id ? { ...item, ...next } : item)));

  const remove = async (template) => {
    try {
      await templateApi.remove(template.id);
      setTemplates((list) => list.filter((item) => item.id !== template.id));
      setSelected(null);
      setUndo(template);
    } catch (failure) { setError(failure.message); }
  };
  const restore = async () => {
    const template = undo;
    setUndo(null);
    try { await templateApi.restore(template.id); await load(); setSelected(template.id); } catch (failure) { setError(failure.message); }
  };

  if (typeof document === "undefined") return null;
  const tabButton = (id, label) => (
    <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
      className={cn("cursor-pointer rounded-md px-3 py-1.5 text-xs", tab === id ? "bg-ink-600 text-white" : "text-white/55 hover:text-white")}>{label}</button>
  );
  const sideButton = (active, label, onClick) => (
    <button type="button" onClick={onClick} aria-current={active}
      className={cn("w-full cursor-pointer rounded-md px-2.5 py-1.5 text-left text-xs", active ? "bg-ink-600 text-white" : "text-white/60 hover:bg-white/[0.06] hover:text-white")}>{label}</button>
  );

  return createPortal(
    <div className="fixed inset-0 z-[200] grid place-items-center bg-black/55 p-4" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        role="dialog" aria-modal="true" aria-labelledby={titleId}
        onKeyDown={(event) => event.key === "Escape" && (event.stopPropagation(), onClose())}
        className="relative flex h-[min(46rem,90dvh)] w-full max-w-[64rem] flex-col overflow-hidden rounded-2xl border border-line bg-ink-750 shadow-pop"
      >
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
          <h2 id={titleId} className="text-sm font-semibold text-white">{mode === "new" ? "Start a new board" : "Templates"}</h2>
          <div role="tablist" className="flex gap-1">
            {tabButton("templates", "Templates")}
            {tabButton("blueprints", "Blueprints")}
            {isAdmin && tabButton("insights", "Usage insights")}
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            {mode === "board" && (
              <>
                <button type="button" disabled={!canInsert || !selectionCount} onClick={onSaveSelection} className="cursor-pointer rounded-md border border-line px-2.5 py-1.5 text-xs text-white/70 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40">Save selection as template</button>
                <button type="button" disabled={!canInsert} onClick={onSaveBoard} className="cursor-pointer rounded-md border border-line px-2.5 py-1.5 text-xs text-white/70 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40">Save board as template</button>
              </>
            )}
            {mode === "new" && <button type="button" onClick={onBlank} className="cursor-pointer rounded-md border border-line px-2.5 py-1.5 text-xs text-white/70 hover:bg-white/10">Blank board</button>}
            {onScratch && <button type="button" onClick={onScratch} className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-line px-2.5 py-1.5 text-xs text-white/70 hover:bg-white/10"><Plus className="h-3.5 w-3.5" /> Create from scratch</button>}
            <button type="button" onClick={onClose} aria-label="Close" className="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-white/50 hover:bg-white/10 hover:text-white"><X className="h-4 w-4" /></button>
          </div>
        </div>

        {tab === "blueprints" && <BlueprintsTab projectId={projectId} onMade={onBlueprintMade} />}
        {tab === "insights" && <InsightsTab />}
        {tab === "templates" && (
          <div className="grid min-h-0 flex-1 grid-cols-[11rem_minmax(0,1fr)_20rem] max-lg:grid-cols-[minmax(0,1fr)] max-lg:overflow-y-auto">
            <nav aria-label="Template filters" className="scroll-thin flex flex-col gap-0.5 overflow-y-auto border-r border-line p-3 max-lg:flex-row max-lg:flex-wrap max-lg:border-b max-lg:border-r-0">
              {TEMPLATE_COLLECTIONS.map((item) => sideButton(!mine && collection === item.id, item.label, () => { setMine(false); setCollection(item.id); }))}
              {sideButton(mine, "My templates", () => { setMine(true); setCollection("all"); })}
              <div className="my-2 h-px bg-line max-lg:hidden" />
              {sideButton(category === "all", "All categories", () => setCategory("all"))}
              {Object.entries(TEMPLATE_CATEGORY_LABELS).map(([id, label]) => sideButton(category === id, label, () => setCategory(id)))}
            </nav>
            <div className="flex min-h-0 min-w-0 flex-col">
              <div className="relative border-b border-line p-3">
                <Search className="pointer-events-none absolute left-6 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/35" />
                <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search templates" aria-label="Search templates"
                  className="w-full rounded-lg border border-line bg-ink-700 py-2 pl-8 pr-3 text-xs text-white outline-none placeholder:text-white/30 focus:border-white/25" />
              </div>
              <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-3">
                {error && <p role="alert" className="mb-2 text-xs text-red-300">{error}</p>}
                {templates === null && !error ? <Loader2 className="mx-auto mt-10 h-5 w-5 animate-spin text-white/40" /> : shown.length === 0 ? (
                  <p className="mt-10 text-center text-xs text-white/45">No templates match. Try a different search or filter.</p>
                ) : (
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3">
                    {shown.map((item) => <Card key={item.id} template={item} active={item.id === selected} onSelect={setSelected} />)}
                  </div>
                )}
              </div>
            </div>
            <aside aria-label="Template preview" className="flex min-h-0 flex-col border-l border-line max-lg:border-l-0 max-lg:border-t">
              {current ? (
                <Detail template={current} mode={mode} canInsert={canInsert} isAdmin={isAdmin} onUse={onUse} onChanged={patch} onEdit={onEdit} onEditContent={onEditContent} onDelete={remove} />
              ) : (
                <p className="m-auto px-6 text-center text-xs text-white/45">Select a template to preview it.</p>
              )}
            </aside>
          </div>
        )}

        {mode === "new" && (
          <label className="flex items-center gap-2 border-t border-line px-5 py-2.5 text-xs text-white/65">
            <input type="checkbox" checked={showPicker} onChange={(e) => { setShowPicker(e.target.checked); writeShowPicker(e.target.checked); }} />
            Show this picker on every new board
          </label>
        )}
        {undo && (
          <div role="status" className="absolute bottom-14 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-full border border-line bg-ink-700 px-4 py-2 text-xs text-white shadow-pop">
            <Check className="h-3.5 w-3.5 text-green-400" /> Deleted {undo.name}
            <button type="button" onClick={restore} className="cursor-pointer font-medium text-brand-light underline">Undo</button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
