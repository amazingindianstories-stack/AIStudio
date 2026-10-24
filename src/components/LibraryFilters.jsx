"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ListFilter, Loader2, Search, X } from "lucide-react";
import { useStore } from "@/lib/store";
import { apiFetch } from "@/lib/api";
import { scopeToQuery } from "@/lib/feed-scope";
import { historyFilterToParams } from "@/lib/history-query";
import { getModelDefinition } from "@/lib/model-registry";
import { activeLibraryFilters, DATE_PRESETS, emptyLibraryFilters, FILTER_LABELS, FILTER_VALUES,
  libraryDateBounds, libraryDayLabel, librarySourceKey, localDateKey, normalizeLibraryFilters } from "@/lib/library-filters";
import { cn } from "@/lib/utils";

const CATEGORIES = [["types", "Type"], ["models", "Model"], ["date", "Date created"],
  ["resolutions", "Resolution"], ["aspects", "Aspect ratio"], ["video", "Video"], ["creators", "Creator"], ["more", "More"]];
const DESCRIPTIONS = {
  types: "Start with the kind of work you need.", models: "Choose models used in this library.",
  date: "When the generation was started.", resolutions: "The setting used to create the work.",
  aspects: "Find the shape that fits your edit.", video: "Duration and render stage apply to videos.",
  creators: "Find your work or a teammate's exploration.", more: "Useful when you are checking a render.",
};

function categoryCount(category, draft) {
  if (category === "video") return Number(Boolean(draft.durations.length)) + Number(Boolean(draft.stages.length));
  if (category === "more") return Number(Boolean(draft.statuses.length)) + Number(Boolean(draft.bitrates.length));
  if (category === "types") return Number(Boolean(draft.types.length)) + Number(draft.favorite);
  if (category === "date") return Number(draft.date !== "any");
  return draft[category].length;
}

export function libraryValueLabel(key, value, users = {}, actorId) {
  if (key === "models") return getModelDefinition(value)?.name || value;
  if (key === "creators") return value === "unknown" ? "Unknown creator" : value === actorId ? "You" : users[value]?.name || "Former creator";
  if (key === "resolutions") {
    const [kind, resolution] = value.split(":");
    return `${kind === "image" ? "Image" : kind === "video" ? "Video" : "Depth"} ${resolutionSettingLabel(resolution).replace("Not", "not")}`;
  }
  return FILTER_VALUES[key]?.find(([id]) => id === value)?.[1] || value;
}

function resolutionSettingLabel(setting) {
  return setting === "unknown" ? "Not recorded" : setting.toUpperCase().replace("P", "p");
}

/** A small outline of a recorded ratio, scaled into an 18x14 box. */
function RatioOutline({ value }) {
  const [width, height] = String(value).split(":").map(Number);
  const valid = width > 0 && height > 0;
  const wide = valid && width / height >= 18 / 14;
  return <span className="library-filter-ratio" aria-hidden="true">
    {valid && <i style={wide ? { width: 18, height: Math.max(4, 18 * height / width) } : { width: Math.max(4, 14 * width / height), height: 14 }} />}
  </span>;
}

export function LibraryFilterChips() {
  const filters = useStore(s => s.libraryFilters);
  const kind = useStore(s => s.filterKind);
  const setFilters = useStore(s => s.setLibraryFilters);
  const users = useStore(s => s.usersById);
  const actorId = useStore(s => s.currentUser?.id);
  const normalized = normalizeLibraryFilters(filters);
  if (kind !== "all" && !normalized.types.length) normalized.types = [kind];
  const active = activeLibraryFilters(normalized);
  if (!active.length) return null;
  const remove = key => setFilters({ ...normalized, [key]: key === "date" ? "any" : key === "favorite" ? false : [] });
  return <div className="library-filter-chips" aria-label="Active library filters">
    {active.map(key => {
      const values = key === "date" ? normalized.date === "custom" ? `${libraryDayLabel(normalized.from)} to ${libraryDayLabel(normalized.through)}` : DATE_PRESETS[normalized.date]
        : key === "favorite" ? "Favourites only" : normalized[key].map(value => libraryValueLabel(key, value, users, actorId)).join(" + ");
      const label = key === "favorite" ? values : `${FILTER_LABELS[key]}: ${values}`;
      return <span key={key} className="library-filter-chip" title={label}><span>{label}</span>
        <button type="button" onClick={() => remove(key)} aria-label={`Remove ${label}`}><X className="h-3 w-3" /></button></span>;
    })}
    <button type="button" className="library-filter-clear" onClick={() => setFilters(emptyLibraryFilters())}>Clear filters</button>
  </div>;
}

/** Politely announces an applied filter set once its first page settles; a paged prefix is never called a total. */
export function LibraryResultsAnnouncer() {
  const filters = useStore(s => s.libraryFilters), loading = useStore(s => s.loading);
  const count = useStore(s => s.items.length), more = useStore(s => s.hasMoreHistory);
  const tab = useStore(s => s.rightTab), projectId = useStore(s => s.activeProjectId), folderId = useStore(s => s.activeFolderId);
  const source = librarySourceKey({ tab, projectId, folderId });
  const [pending, setPending] = useState(false), [message, setMessage] = useState("");
  const applied = useRef({ filters, source });
  useEffect(() => {
    // Navigation restores a source's saved filters; only an applied change is announced.
    const previous = applied.current;
    applied.current = { filters, source };
    if (previous.filters !== filters && previous.source === source) setPending(true);
  }, [filters, source]);
  useEffect(() => {
    if (!pending || loading) return;
    setPending(false);
    setMessage(count === 0 ? "No matching work." : more ? "Showing matching work. More loads as you scroll."
      : `Showing ${count} ${count === 1 ? "result" : "results"}.`);
  }, [pending, loading, count, more]);
  return <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">{message}</span>;
}

export function LibraryNoMatches() {
  const filters = useStore(s => s.libraryFilters), kind = useStore(s => s.filterKind), search = useStore(s => s.search);
  const setFilters = useStore(s => s.setLibraryFilters), setSearch = useStore(s => s.setSearch);
  const filtering = activeLibraryFilters(filters).length || kind !== "all";
  const normalized = normalizeLibraryFilters(filters);
  // Video-only facets cannot match a Type that excludes videos; say so instead of hiding the conflict.
  const videoConflict = normalized.types.length > 0 && !normalized.types.includes("video") &&
    (normalized.durations.length || normalized.stages.length || normalized.bitrates.length);
  return <div className="grid h-full place-items-center px-5 text-center">
    <div className="max-w-xs"><Search className="mx-auto mb-3 h-6 w-6 text-white/35" /><h3 className="text-sm font-medium text-white/80">No matching work</h3>
      <p className="mt-2 text-xs leading-5 text-white/45">{videoConflict ? "Duration, stage and bitrate only match videos. Include Videos in Type, or remove those filters."
        : <>Try fewer filters{search.trim() ? " or a different search." : ". Your work is still in this library."}</>}</p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        {Boolean(filtering) && <button type="button" className="rounded-lg bg-white px-3 py-2 text-xs font-medium text-ink-900" onClick={() => setFilters(emptyLibraryFilters())}>Clear filters</button>}
        {search.trim() && <button type="button" className="rounded-lg px-3 py-2 text-xs text-white/65 hover:bg-white/10" onClick={() => setSearch("")}>Clear search</button>}
      </div>
    </div>
  </div>;
}

export function LibraryFilters() {
  const filters = useStore(s => s.libraryFilters), kind = useStore(s => s.filterKind);
  const setFilters = useStore(s => s.setLibraryFilters);
  const tab = useStore(s => s.rightTab), projectId = useStore(s => s.activeProjectId), folderId = useStore(s => s.activeFolderId);
  const actorId = useStore(s => s.currentUser?.id);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null), dialogId = useId();
  const scope = { tab, projectId, folderId, kind: "all", q: "" };
  const source = librarySourceKey(scope);
  useEffect(() => setOpen(false), [source, actorId]);
  const normalized = normalizeLibraryFilters(filters);
  if (kind !== "all" && !normalized.types.length) normalized.types = [kind];
  const count = activeLibraryFilters(normalized).length;
  return <>
    <button ref={triggerRef} type="button" aria-expanded={open} aria-controls={dialogId} aria-haspopup="dialog"
      aria-label={count ? `Filters, ${count} active` : undefined} onClick={() => setOpen(true)} className={cn("library-filter-trigger flex items-center gap-1.5 rounded-full border border-line bg-ink-700/80 px-3 py-1 text-xs text-white/75 hover:text-white", open && "border-brand/40 text-white")}>
      <ListFilter className="h-3 w-3" /><span>Filters</span>{count > 0 && <span className="library-filter-badge">{count}</span>}
    </button>
    {open && <FilterDialog key={`${source}:${actorId}`} id={dialogId} triggerRef={triggerRef} scope={scope} initial={normalized}
      onCancel={() => setOpen(false)} onApply={value => { setFilters(value); setOpen(false); }} />}
  </>;
}

function FilterDialog({ id, triggerRef, scope, initial, onCancel, onApply }) {
  const [draft, setDraft] = useState(initial), [category, setCategory] = useState("types");
  const [catalog, setCatalog] = useState(null), [error, setError] = useState(false), [retry, setRetry] = useState(0), [modelSearch, setModelSearch] = useState("");
  const users = useStore(s => s.usersById), actorId = useStore(s => s.currentUser?.id);
  const dialogRef = useRef(null), categoryRef = useRef(null);
  const titleId = useId(), errorId = useId();
  const source = librarySourceKey(scope);
  useEffect(() => {
    const controller = new AbortController();
    setCatalog(null); setError(false);
    const params = historyFilterToParams(scopeToQuery(scope));
    params.set("options", "1");
    apiFetch(`/api/history?${params}`, { signal: controller.signal, cache: "no-store" }).then(async response => {
      if (!response.ok) throw new Error("options");
      const body = await response.json();
      if (!body.options) throw new Error("options");
      if (!controller.signal.aborted) setCatalog(body.options);
    }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  // Only navigation determines the catalog; draft filters never reduce its options.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, retry]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current, trigger = triggerRef.current;
    dialog.showModal();
    const place = () => {
      const rect = trigger?.getBoundingClientRect();
      if (!rect) return;
      dialog.style.left = `${Math.max(12, Math.min(rect.right - dialog.offsetWidth, window.innerWidth - dialog.offsetWidth - 12))}px`;
      dialog.style.top = `${Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - dialog.offsetHeight - 12))}px`;
    };
    place(); categoryRef.current?.focus();
    const observer = new ResizeObserver(place);
    observer.observe(dialog);
    window.addEventListener("resize", place);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); dialog.close(); trigger?.focus(); };
  }, [triggerRef]);

  const toggle = (key, value) => setDraft(current => ({ ...current, [key]: current[key].includes(value) ? current[key].filter(item => item !== value) : [...current[key], value] }));
  const selectDate = date => {
    const today = new Date(), start = new Date();
    start.setDate(start.getDate() - 6);
    setDraft({ ...draft, date, ...(date === "custom" && !draft.from ? { from: localDateKey(start), through: localDateKey(today) } : {}) });
  };
  const options = (key, values) => values.map(entry => {
    const value = Array.isArray(entry) ? entry[0] : entry;
    const label = Array.isArray(entry) ? entry[1] : libraryValueLabel(key, value, users, actorId);
    return <label key={value} className="library-filter-option"><input type="checkbox" value={value} checked={draft[key].includes(value)} onChange={() => toggle(key, value)} />{key === "aspects" && <RatioOutline value={value} />}<span>{label}</span></label>;
  });
  const mergeOptions = (key, values) => [...new Set([...(values || []), ...draft[key]])];
  // Not recorded appears only when the source has such videos, or the draft already selected it.
  const recorded = (key, wire) => FILTER_VALUES[key].filter(([value]) => value !== "unknown" || catalog?.unrecorded?.includes(wire) || draft[key].includes(value));
  const title = category === "resolutions" ? "Requested resolution" : CATEGORIES.find(([key]) => key === category)[1];
  const dateValid = libraryDateBounds(draft) !== null;
  const needsCatalog = ["models", "resolutions", "aspects", "creators"].includes(category);
  const modelOptions = [...(catalog?.models || [])];
  for (const value of draft.models) if (!modelOptions.some(model => model.value === value)) {
    const definition = getModelDefinition(value);
    modelOptions.push({ value, label: definition?.name || value, kind: definition?.kind || "other", upscale: Boolean(definition?.capabilities?.upscaleMedia) });
  }
  const creatorOptions = mergeOptions("creators", catalog?.creators).sort((a, b) => a === actorId ? -1 : b === actorId ? 1 : libraryValueLabel("creators", a, users, actorId).localeCompare(libraryValueLabel("creators", b, users, actorId)));
  const sectionTitle = text => <h4 className="library-filter-subhead">{text}</h4>;
  return createPortal(<dialog ref={dialogRef} id={id} role="dialog" className="library-filter-dialog" aria-labelledby={titleId} aria-modal="true"
    onCancel={event => { event.preventDefault(); onCancel(); }}
    onKeyDown={event => { if (event.key === "Escape") event.stopPropagation(); }}
    onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onCancel(); } }}>
    <header className="library-filter-header"><h2 id={titleId}>Filters</h2><button type="button" onClick={() => setDraft(emptyLibraryFilters())}>Reset</button><button type="button" aria-label="Cancel filter changes" onClick={onCancel}><X className="h-4 w-4" /></button></header>
    <div className="library-filter-body"><nav className="library-filter-categories" aria-label="Filter categories">
      {CATEGORIES.map(([key, label], index) => { const count = categoryCount(key, draft); return <button ref={index === 0 ? categoryRef : undefined} key={key} type="button" aria-current={category === key ? "true" : undefined} onClick={() => setCategory(key)}>{label}{count > 0 && <span>{count}</span>}</button>; })}
    </nav><div className="library-filter-content"><h3>{title}</h3><p className="library-filter-description">{DESCRIPTIONS[category]}</p>
      {needsCatalog && !catalog && !error ? <p className="flex items-center gap-2 py-5 text-xs text-white/45"><Loader2 className="h-3 w-3 animate-spin" />Loading options...</p>
        : needsCatalog && error ? <div role="alert" className="text-xs text-white/65">Could not load filter options.<button type="button" className="ml-2 underline" onClick={() => setRetry(value => value + 1)}>Try again</button></div> : <>
          {category === "types" && <>{options("types", FILTER_VALUES.types.filter(([key]) => key !== "depth" || catalog?.types?.includes("depth") || draft.types.includes("depth")))}<div className="library-filter-rule" /><label className="library-filter-option"><input type="checkbox" disabled={scope.tab === "favorites"} checked={scope.tab === "favorites" || draft.favorite} onChange={event => setDraft({ ...draft, favorite: event.target.checked })} /><span>Favourites only</span></label><p className="library-filter-help">{scope.tab === "favorites" ? "Already in Favourites. Open All assets to see everything." : "Favourites are shared with your team."}</p></>}
          {category === "models" && <>{modelOptions.length > 8 && <input className="library-filter-search" type="search" aria-label="Search models" placeholder="Search models..." value={modelSearch} onChange={event => setModelSearch(event.target.value)} />}
            {["video", "image", "upscale", "other"].map(group => { const models = modelOptions.filter(model => (model.upscale ? "upscale" : ["image", "video"].includes(model.kind) ? model.kind : "other") === group && model.label.toLowerCase().includes(modelSearch.toLowerCase())); return models.length ? <div key={group}>{sectionTitle(group === "upscale" ? "Upscale" : group === "other" ? "Other" : group === "video" ? "Video" : "Image")}{options("models", models.map(model => [model.value, model.label]))}</div> : null; })}
            {!modelOptions.length && <p className="library-filter-help">No models in this source yet.</p>}</>}
          {category === "date" && <>{Object.entries(DATE_PRESETS).map(([value, label]) => <label key={value} className="library-filter-option"><input type="radio" name={`${id}-date`} value={value} checked={draft.date === value} onChange={() => selectDate(value)} /><span>{label}</span></label>)}
            {draft.date === "custom" && <><div className="library-filter-dates"><label>From<input type="date" value={draft.from} aria-describedby={!dateValid ? errorId : undefined} onChange={event => setDraft({ ...draft, from: event.target.value })} /></label><label>Through<input type="date" value={draft.through} aria-describedby={!dateValid ? errorId : undefined} onChange={event => setDraft({ ...draft, through: event.target.value })} /></label></div>{!dateValid && <p id={errorId} className="mt-2 text-[11px] text-red-200">Choose a start date on or before the end date.</p>}</>}
            <p className="library-filter-help">{Intl.DateTimeFormat().resolvedOptions().timeZone} · Calendar days, including today.</p></>}
          {category === "resolutions" && <>{["image", "video", "depth"].map(kind => { const values = mergeOptions("resolutions", catalog?.resolutions).filter(value => value.startsWith(`${kind}:`)); return values.length ? <div key={kind}>{sectionTitle(kind === "image" ? "Image" : kind === "video" ? "Video" : "Depth")}{options("resolutions", values.map(value => [value, resolutionSettingLabel(value.split(":")[1])]))}</div> : null; })}<p className="library-filter-help">Generation settings, not measured master dimensions.</p></>}
          {category === "aspects" && <>{options("aspects", mergeOptions("aspects", ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", ...(catalog?.aspects || [])]))}<p className="library-filter-help">Uses the requested ratio. No crop is applied.</p></>}
          {category === "video" && <>{draft.types.length === 1 && draft.types[0] === "image" && <p className="library-filter-help" style={{ marginTop: 0 }}>Images are selected. Include Videos in Type, or remove video filters below.</p>}{sectionTitle("Duration")}{options("durations", recorded("durations", "durationBucket"))}<div className="library-filter-rule" />{sectionTitle("Render stage")}{options("stages", recorded("stages", "stage"))}<p className="library-filter-help">Final means a recorded non-draft video. Missing stage is not treated as Final.</p></>}
          {category === "creators" && <>{options("creators", creatorOptions)}{!creatorOptions.length && <p className="library-filter-help">No creators in this source yet.</p>}</>}
          {category === "more" && <>{sectionTitle("Status")}{options("statuses", FILTER_VALUES.statuses)}<div className="library-filter-rule" />{sectionTitle("Video bitrate")}{options("bitrates", recorded("bitrates", "bitrate"))}<p className="library-filter-help">The requested bitrate mode. Filtering never changes a master.</p></>}
        </>}
    </div></div><footer className="library-filter-footer"><span>Changes apply together</span><button type="button" onClick={onCancel}>Cancel</button><button type="button" className="library-filter-apply" disabled={!dateValid} onClick={() => onApply(draft)}>Show results</button></footer>
  </dialog>, document.body);
}
