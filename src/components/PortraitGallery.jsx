"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ImagePlus, Loader2, Search, Trash2, Upload, X } from "lucide-react";
import { useStore } from "@/lib/store";
import { capability } from "@/lib/model-registry";
import { cn } from "@/lib/utils";
import { askText } from "@/lib/ask-text";
import { notify } from "@/lib/notify";
import { getNextGridFocus } from "@/lib/grid-navigation";
import { droppedLibraryItems, validatePortraitDrop } from "@/lib/asset-drag-contract";
import { downloadPortrait, portraitAttachable, portraitDropImages } from "@/lib/portraits";
import { useDropzoneGuard } from "@/lib/use-dropzone-guard";
import { useMarqueeSelection } from "@/lib/use-marquee-selection";
import { ConfirmActionDialog } from "./ConfirmActionDialog";
import { PortraitCard, PortraitUploadTile } from "./PortraitCard";
import { PortraitLightbox } from "./PortraitLightbox";

const SEARCH_DEBOUNCE_MS = 250;
const GRID = "grid grid-cols-[repeat(auto-fill,minmax(136px,1fr))] gap-3";
const idsOf = (list) => list.map((p) => p.id);

/** The shared Portrait Gallery. Mounted for the life of the page, rendered only while open. */
export function PortraitGallery() {
  const open = useStore((state) => state.portraitGalleryOpen);
  return open ? <PortraitGalleryDialog /> : null;
}

/** Library images dropped in from the app arrive as URLs; fetch them into files like any other upload. */
async function filesFromLibraryItems(items) {
  const files = [];
  const problems = [];
  for (const item of portraitDropImages(items)) {
    try {
      const response = await fetch(item.url);
      if (!response.ok) throw new Error("Image unavailable");
      const blob = await response.blob();
      const extension = blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : "jpg";
      files.push(new File([blob], `${(item.prompt || "Portrait").slice(0, 40)}.${extension}`, { type: blob.type }));
    } catch (error) {
      problems.push(error.message);
    }
  }
  return { files, problems };
}

function PortraitGalleryDialog() {
  const portraits = useStore((state) => state.portraits);
  const uploads = useStore((state) => state.portraitUploads);
  const loadPortraits = useStore((state) => state.loadPortraits);
  const uploadPortraits = useStore((state) => state.uploadPortraits);
  const dismissUpload = useStore((state) => state.dismissPortraitUpload);
  const setOpen = useStore((state) => state.setPortraitGalleryOpen);
  const { items, enabled, next, loading, loadingMore } = portraits;
  const available = enabled === true;

  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState([]);
  const [previewId, setPreviewId] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [focusId, setFocusId] = useState(null);
  const dialog = useRef(null);
  const scrollRef = useRef(null);
  const gridRef = useRef(null);
  const sentinel = useRef(null);
  const input = useRef(null);
  const anchor = useRef(null);
  const itemsRef = useRef(items);
  const selectedRef = useRef(selected);
  itemsRef.current = items;
  selectedRef.current = selected;
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const chosen = useMemo(() => items.filter((p) => selectedSet.has(p.id)), [items, selectedSet]);
  const preview = items.find((p) => p.id === previewId) || null;

  useEffect(() => {
    const trigger = document.activeElement;
    dialog.current?.focus();
    void loadPortraits({ query: "" });
    return () => { if (trigger?.isConnected) trigger.focus?.(); };
  }, [loadPortraits]);

  // Typing searches the whole gallery on the server, so results are not limited to the loaded page.
  const firstSearch = useRef(true);
  useEffect(() => {
    if (firstSearch.current) { firstSearch.current = false; return undefined; }
    const timer = setTimeout(() => { void loadPortraits({ query: search.trim() }); }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search, loadPortraits]);

  // Portraits that left the gallery (deleted here or by someone else) leave the selection and the viewer.
  useEffect(() => {
    const live = new Set(items.map((p) => p.id));
    setSelected((current) => (current.every((id) => live.has(id)) ? current : current.filter((id) => live.has(id))));
    setPreviewId((current) => (current && !live.has(current) ? null : current));
  }, [items]);

  useEffect(() => {
    const target = sentinel.current;
    if (!target || !next || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) void loadPortraits({ more: true });
    }, { root: scrollRef.current, rootMargin: "600px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [next, items.length, loadPortraits]);

  const marquee = useMarqueeSelection({
    scrollRef,
    itemAttribute: "data-portrait-id",
    getSelected: () => selectedRef.current,
    setSelected,
    onClickBackground: () => setSelected((current) => (current.length ? [] : current)),
  });

  const choose = useCallback((id, e) => {
    const list = itemsRef.current;
    const end = list.findIndex((p) => p.id === id);
    const start = list.findIndex((p) => p.id === anchor.current);
    if (e?.shiftKey && start >= 0) setSelected(list.slice(Math.min(start, end), Math.max(start, end) + 1).map((p) => p.id));
    else setSelected((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
    if (!e?.shiftKey) anchor.current = id;
  }, []);
  const getTargets = useCallback((id) => {
    const list = itemsRef.current;
    const picked = selectedRef.current;
    return picked.length > 1 && picked.includes(id) ? list.filter((p) => picked.includes(p.id)) : list.filter((p) => p.id === id);
  }, []);

  const addToPrompt = useCallback((targets) => {
    const state = useStore.getState();
    const room = Math.max(0, capability(state.model, "maxReferenceImages", 50) - (state.referenceKinds || []).filter((kind) => kind !== "video").length);
    if (targets.length > room) {
      setError(`This model has room for ${room} more image ${room === 1 ? "reference" : "references"}. Select fewer portraits or change model.`);
      return;
    }
    const result = state.attachPortraitsToComposer(targets);
    if (!result?.ok) setError(result?.error || "Could not add portraits.");
  }, []);

  const runDelete = useCallback(async (targets) => {
    setBusy(true);
    setError("");
    const result = await useStore.getState().deletePortraits(idsOf(targets));
    setBusy(false);
    setPendingDelete(null);
    if (result.failed.length) {
      setSelected(result.failed.map((f) => f.id));
      const reasons = Array.from(new Set(result.failed.map((f) => f.error))).join(" ");
      setError(`${result.removed ? `Deleted ${result.removed}. ` : ""}${result.failed.length} could not be deleted and ${result.failed.length === 1 ? "is" : "are"} still selected. ${reasons}`);
    }
  }, []);

  const actions = useMemo(() => ({
    addToPrompt,
    download: (portrait) => { void downloadPortrait(portrait); },
    rename: async (portrait) => {
      const name = await askText({ title: "Rename portrait", defaultValue: portrait.name, confirmLabel: "Rename", maxLength: 120 });
      if (name == null || !name.trim() || name.trim() === portrait.name) return;
      const result = await useStore.getState().renamePortrait(portrait.id, name);
      if (!result.ok) notify(result.error);
    },
    remove: (targets, { confirm = true } = {}) => (confirm ? setPendingDelete(targets) : runDelete(targets)),
  }), [addToPrompt, runDelete]);

  const uploadFiles = useCallback(async (files) => {
    if (!files.length) return;
    setError("");
    await uploadPortraits(files);
  }, [uploadPortraits]);

  const drop = useDropzoneGuard({ onValidate: (e) => validatePortraitDrop(e, useStore.getState()) });
  const onDrop = async (e) => {
    e.preventDefault();
    drop.handleDrop(e);
    if (!available) return;
    const verdict = validatePortraitDrop(e, useStore.getState());
    if (!verdict.valid) { setError(verdict.reason); return; }
    // Read synchronously: the DataTransfer is emptied once the handler yields.
    const files = Array.from(e.dataTransfer?.files || []);
    const library = files.length ? null : droppedLibraryItems(e, useStore.getState());
    if (files.length) { await uploadFiles(files); return; }
    if (!library) return;
    const { files: fetched, problems } = await filesFromLibraryItems(library);
    if (problems.length) setError(Array.from(new Set(problems)).join(" "));
    await uploadFiles(fetched);
  };

  const tabId = items.some((p) => p.id === focusId) ? focusId : items[0]?.id;
  const focusCard = (id) => {
    setFocusId(id);
    const node = gridRef.current?.querySelector(`[data-portrait-id="${id}"]`);
    node?.scrollIntoView({ block: "nearest" });
    node?.focus({ preventScroll: true });
  };
  const gridColumns = () => {
    const cards = Array.from(gridRef.current?.querySelectorAll("[data-portrait-id]") ?? []);
    const per = Math.max(1, cards.filter((card) => card.offsetTop === cards[0]?.offsetTop).length);
    return Array.from({ length: per }, (_, c) => itemsRef.current.filter((_item, i) => i % per === c));
  };
  const onGridKeyDown = (e) => {
    const card = e.target.closest?.("[data-portrait-id]");
    if (!card || e.target !== card) return;
    const id = card.getAttribute("data-portrait-id");
    if (e.key === " ") { e.preventDefault(); choose(id, { shiftKey: false }); return; }
    if (e.key === "Enter") { e.preventDefault(); setPreviewId(id); return; }
    const direction = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down", Home: "home", End: "end" }[e.key];
    if (!direction) return;
    e.preventDefault();
    const list = itemsRef.current;
    const index = list.findIndex((p) => p.id === id);
    const nextId = direction === "left" ? list[index - 1]?.id
      : direction === "right" ? list[index + 1]?.id
      : getNextGridFocus(gridColumns(), id, direction, list);
    if (!nextId) return;
    if (e.shiftKey) {
      if (!anchor.current) anchor.current = id;
      choose(nextId, { shiftKey: true });
    }
    focusCard(nextId);
  };

  const onDialogKeyDown = (e) => {
    if (e.target.matches("input,textarea,select") && e.key !== "Tab") return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSelected(idsOf(items));
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (pendingDelete || preview) return;
      if (selected.length) setSelected([]);
      else setOpen(false);
    }
    if (e.key === "Tab") {
      const nodes = Array.from(dialog.current.querySelectorAll('button:not(:disabled),input:not([type=file]),select,[tabindex="0"]'));
      const first = nodes[0], last = nodes.at(-1);
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
  };

  const allSelected = items.length > 0 && selected.length === items.length;
  const showUploads = uploads.length > 0;
  const empty = available && !loading && !items.length && !showUploads;
  const searching = search.trim().length > 0;

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/75 p-3 backdrop-blur-sm sm:p-4" onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <section
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Portrait Gallery"
        onKeyDown={onDialogKeyDown}
        onDragEnter={available ? drop.handleDragEnter : undefined}
        onDragOver={available ? drop.handleDragOver : (e) => e.preventDefault()}
        onDragLeave={available ? drop.handleDragLeave : undefined}
        onDrop={onDrop}
        className="relative flex h-[88dvh] w-full max-w-[1200px] flex-col overflow-hidden rounded-2xl border border-line bg-ink-850 text-white shadow-pop"
      >
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line px-4">
          <h2 className="truncate text-sm font-semibold">Portrait Gallery</h2>
          <div className="flex items-center gap-2">
            {available && (
              <button type="button" onClick={() => input.current?.click()} className="flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-zinc-950 transition hover:bg-zinc-200">
                <Upload className="h-3.5 w-3.5" /> Upload
              </button>
            )}
            <button type="button" aria-label="Close Portrait Gallery" onClick={() => setOpen(false)} className="grid h-8 w-8 place-items-center rounded-lg text-white/70 transition hover:bg-white/10 hover:text-white">
              <X className="h-4 w-4" />
            </button>
          </div>
          <input
            ref={input}
            type="file"
            multiple
            accept="image/*"
            aria-label="Upload portraits"
            className="hidden"
            onChange={(e) => { const files = Array.from(e.target.files || []); e.target.value = ""; void uploadFiles(files); }}
          />
        </header>

        <div className="relative flex min-h-0 flex-1">
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            {available && (selected.length > 0 ? (
              <div data-testid="portrait-selection-toolbar" className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-line bg-ink-800/90 px-4 text-xs select-none">
                <div className="flex min-w-0 items-center gap-2.5">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={allSelected}
                    aria-label="Select all"
                    onClick={() => setSelected(allSelected ? [] : idsOf(items))}
                    className={cn("grid h-4 w-4 shrink-0 place-items-center rounded border transition", allSelected ? "border-brand bg-brand text-ink-900" : "border-white/40 text-transparent hover:border-white")}
                  >
                    <Check className="h-3 w-3" strokeWidth={3} />
                  </button>
                  <span className="truncate font-semibold text-white">{selected.length} selected</span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    disabled={busy || chosen.some((p) => !portraitAttachable(p))}
                    title={chosen.some((p) => !portraitAttachable(p)) ? "Portraits that can't be used can't be added to a prompt" : undefined}
                    onClick={() => addToPrompt(chosen)}
                    className="rounded-full bg-brand/20 px-3 py-1 font-semibold text-brand transition hover:bg-brand/30 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Add {selected.length} to prompt
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setPendingDelete(chosen)}
                    className="flex items-center gap-1.5 rounded-full bg-red-500/15 px-3 py-1 font-semibold text-red-300 transition hover:bg-red-500/25 disabled:opacity-40"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Delete {selected.length}
                  </button>
                  <button type="button" aria-label="Clear selection" title="Clear selection (Esc)" onClick={() => setSelected([])} className="grid h-7 w-7 place-items-center rounded-md text-white/50 transition hover:bg-white/10 hover:text-white">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-ink-850 px-4 select-none">
                <div className="relative w-full max-w-sm sm:max-w-md">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/35" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Escape" && search) { e.preventDefault(); e.stopPropagation(); setSearch(""); } }}
                    placeholder="Search portraits…"
                    aria-label="Search portraits"
                    className="w-full rounded-full border border-line bg-ink-700/80 py-1 pl-8 pr-8 text-xs text-white/90 outline-none transition placeholder:text-white/35 focus:border-brand/40 focus:bg-ink-650"
                  />
                  {search && (
                    <button type="button" aria-label="Clear search" onClick={() => setSearch("")} className="absolute right-2 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-full text-white/45 hover:text-white">
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </div>
            ))}

            {error && (
              <p role="alert" className="flex items-start justify-between gap-3 border-b border-line bg-red-500/10 px-4 py-2 text-xs text-red-200">
                <span>{error}</span>
                <button type="button" aria-label="Dismiss message" onClick={() => setError("")} className="shrink-0 text-red-200/70 hover:text-white"><X className="h-3.5 w-3.5" /></button>
              </p>
            )}

            <div
              ref={scrollRef}
              tabIndex={-1}
              {...marquee.handlers}
              className={cn("scroll-thin relative min-h-0 flex-1 overflow-y-auto px-4 py-4 outline-none", marquee.active && "cursor-crosshair select-none")}
            >
              {marquee.active && (
                <div ref={marquee.overlayRef} data-testid="portrait-grid-marquee" className="pointer-events-none absolute z-40 rounded border border-brand bg-brand/15 shadow-sm" />
              )}
              {enabled === false ? (
                <p className="grid h-full min-h-[40vh] place-items-center text-center text-sm text-white/50">Portraits are unavailable right now.</p>
              ) : enabled === null && portraits.error && !loading ? (
                <div role="alert" className="grid h-full min-h-[40vh] place-items-center text-center text-sm text-white/55">
                  <div>
                    <p>{portraits.error}</p>
                    <button type="button" onClick={() => loadPortraits({ query: search.trim() })} className="mt-3 rounded-lg bg-white/10 px-3 py-1.5 font-medium text-white hover:bg-white/15">Retry</button>
                  </div>
                </div>
              ) : enabled === null || (loading && !items.length && !showUploads) ? (
                <div role="status" className={GRID}>
                  {Array.from({ length: 12 }, (_, i) => <div key={i} style={{ paddingBottom: "125%" }} className="skeleton rounded-xl" />)}
                  <span className="sr-only">Loading portraits</span>
                </div>
              ) : empty ? (
                <div className="grid h-full min-h-[40vh] place-items-center text-center">
                  {searching ? (
                    <p className="text-sm text-white/50">No portraits match &ldquo;{search.trim()}&rdquo;.</p>
                  ) : (
                    <div className="max-w-xs">
                      <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl border border-dashed border-white/25 text-white/55"><ImagePlus className="h-5 w-5" /></div>
                      <p className="mt-3 text-sm font-medium text-white/85">Drop images here</p>
                      <p className="mt-1 text-xs leading-5 text-white/45">Add one or many portraits by dragging them in. Faces in your prompt references appear here automatically.</p>
                      <button type="button" onClick={() => input.current?.click()} className="mt-4 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium text-white hover:bg-white/15">Choose images</button>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <div ref={gridRef} role="group" aria-label="Portraits" onKeyDown={onGridKeyDown} className={GRID}>
                    {uploads.map((upload) => <PortraitUploadTile key={upload.key} upload={upload} onDismiss={dismissUpload} />)}
                    {items.map((portrait) => (
                      <PortraitCard
                        key={portrait.id}
                        portrait={portrait}
                        selected={selectedSet.has(portrait.id)}
                        tabbable={portrait.id === tabId}
                        getTargets={getTargets}
                        onChoose={choose}
                        onOpen={setPreviewId}
                        onFocusCard={setFocusId}
                        actions={actions}
                      />
                    ))}
                  </div>
                  {next && (
                    <div ref={sentinel} className="flex h-16 w-full items-center justify-center text-xs text-white/35">
                      {loadingMore ? <span className="flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading more…</span> : null}
                    </div>
                  )}
                </>
              )}
            </div>
          </main>
          {preview && (
            <PortraitLightbox
              embedded
              asset={preview}
              assets={items}
              onClose={() => setPreviewId(null)}
              onSelectAsset={(p) => setPreviewId(p.id)}
              onAttach={(p) => addToPrompt([p])}
              onDelete={(p) => setPendingDelete([p])}
              onRename={(id, name) => useStore.getState().renamePortrait(id, name)}
            />
          )}
        </div>

        {drop.isDragging && available && (
          <div data-testid="portrait-drop-overlay" className="pointer-events-none absolute inset-2 z-30 grid place-items-center rounded-xl border-2 border-dashed border-white/40 bg-ink-900/85 text-center backdrop-blur-[2px]">
            <div>
              <ImagePlus className="mx-auto h-8 w-8 text-white/80" />
              <p className="mt-3 text-sm font-semibold">{drop.isValid ? "Drop images to add them" : "Only images can be added"}</p>
              <p className="mt-1 text-xs text-white/55">{drop.isValid ? "Release to upload them as portraits" : drop.validationReason}</p>
            </div>
          </div>
        )}
      </section>
      <ConfirmActionDialog
        open={!!pendingDelete}
        title={`Delete ${pendingDelete?.length || 0} ${pendingDelete?.length === 1 ? "portrait" : "portraits"}?`}
        description={`${pendingDelete?.slice(0, 6).map((p) => p.name).join(", ") || ""}${pendingDelete?.length > 6 ? ", ..." : ""}. They are removed for everyone who uses the gallery.`}
        confirmLabel={`Delete ${pendingDelete?.length || 0}`}
        destructive
        busy={busy}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => runDelete(pendingDelete)}
      />
    </div>
  );
}
