"use client";

import { create } from "zustand";
import type {
  Asset,
  AssetKind,
  GenerationItem,
  GenerationKind,
  Project,
  PublicUser,
} from "./types";
import {
  DEFAULTS,
  MODELS,
  HISTORY_PAGE_SIZE,
  aspectRatiosForModel,
  durationsForModel,
  resolutionsForModel,
  supportsAudio,
  supportsVideoReference,
  supportsVideoEditExtend,
  MAX_REFERENCE_VIDEOS,
  type VideoTaskMode,
} from "./config";
import { encodeBlobWithBudget } from "./client-image-budget";
import { renumberImgMentions } from "./mentions";
import { inlineMediaUrl } from "./utils";
import { historyFilterToParams } from "./history-query";
import {
  clearFeedCache,
  dropCached,
  getCached,
  patchCached,
  putFeedCache,
  writeCachedItems,
} from "./feed-cache";
import {
  compareInScope,
  matchesScope,
  scopeKey,
  scopeToQuery,
  type FeedScope,
  type FeedTab,
} from "./feed-scope";

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  role: string;
  color: string | null;
  avatarUrl: string | null;
}

export interface AssetDraft {
  id?: string;
  kind: AssetKind;
  name: string;
  description?: string;
  images: string[]; // mix of existing /assets paths and new data URLs
}

type RightTab = FeedTab;

export interface HistoryCounts {
  /** Per-folder breakdown for the active project. */
  project: { total: number; unsorted: number; byFolder: Record<string, number> };
  /** Everything matching the current kind/search filters. */
  allAssets: number;
  favorites: number;
}

const EMPTY_COUNTS: HistoryCounts = {
  project: { total: 0, unsorted: 0, byFolder: {} },
  allAssets: 0,
  favorites: 0,
};

interface ComposerState {
  mode: GenerationKind;
  model: string;
  aspectRatio: string;
  resolution: string;
  duration: number;
  batchCount: number; // jobs enqueued per Generate press (queue caps concurrency)
  /** Ask the provider for a synchronised audio track. Only meaningful on
   *  models where config.supportsAudio is true; setModel forces it off
   *  otherwise, so it can never be silently true on a path that ignores it. */
  generateAudio: boolean;
  /** Seedance 2.5 only: "edit"/"extend" an attached clip instead of ordinary
   *  generation. Only meaningful where config.supportsVideoEditExtend is
   *  true; setModel forces it back to "generate" otherwise. */
  videoTaskMode: VideoTaskMode;
  prompt: string;
  referenceImages: string[]; // data URLs
  /** Stored refs (`/api/media/...`) of library clips used as video references.
   *  Not data URLs: a clip is far too large to carry through the composer, and
   *  the provider is handed a presigned URL server-side instead. */
  referenceVideos: string[];
}

interface AppState extends ComposerState {
  view: "studio" | "canvas";
  /** The active scope's feed — the rows the right panel is showing. Server
   *  filtered and paged; it is no longer a global window that every view
   *  filters down in the browser. */
  items: GenerationItem[];
  hasMoreHistory: boolean;
  loading: boolean;
  /** True while a background revalidation of an already-populated scope is in
   *  flight. Distinct from `loading`, which means "nothing to show yet" — the
   *  difference is what lets a cached scope reappear instantly instead of
   *  flashing a skeleton over content that is about to be identical. */
  refreshing: boolean;
  /** True counts from the server, for the folder rail and the tabs. */
  counts: HistoryCounts;
  /** Identity of the scope `items` belongs to. The grid resets its scroll
   *  position when this changes — which is not the same as when `loading`
   *  changes, because a cached scope is served without ever entering a loading
   *  state and would otherwise open halfway down the previous view. */
  feedKey: string;

  /** The project's own chronological thread, backing the centre chat panel.
   *  Scoped independently of the right panel so browsing the library never
   *  empties the conversation. */
  threadItems: GenerationItem[];
  threadLoading: boolean;

  /** Rows that arrived from the live feed while the grid was scrolled away
   *  from the top. Held back rather than inserted, because inserting above the
   *  viewport shifts everything the user is currently reading. */
  pendingItems: GenerationItem[];
  /** Set by the grid: true when it is scrolled at (or near) the top, where an
   *  insert is visible and harmless. */
  feedPinned: boolean;
  /** Whether the right-hand assets panel is expanded. Lives here rather than in
   *  page.tsx because the chat header renders a shortcut strip that stands in
   *  for the panel while it is collapsed, and the two must not both be on
   *  screen. Defaults CLOSED so the workspace opens on the conversation. */
  rightPanelOpen: boolean;

  generating: boolean;
  rightTab: RightTab;
  mobileHistoryOpen: boolean;
  activeId: string | null;
  search: string;
  filterKind: "all" | GenerationKind;
  selectedIds: string[]; // multi-select in the Assets tab

  // reusable reference assets (consistency library)
  assets: Asset[];
  /** True while /api/assets is in flight. Without it the library renders an
   *  empty array as "No assets yet." during load, which is a wrong answer
   *  rather than a missing one. */
  assetsLoading: boolean;
  assetLibraryOpen: boolean;
  editingAsset: Asset | "new" | null;

  // auth + attribution
  currentUser: CurrentUser | null;
  usersById: Record<string, PublicUser>;

  // projects (Project tab)
  projects: Project[];
  activeProjectId: string | null;
  activeFolderId: string | null; // null = All assets / unsorted

  // view
  setView: (v: "studio" | "canvas") => void;

  // composer setters
  setMode: (mode: GenerationKind) => void;
  setModel: (model: string) => void;
  setAspectRatio: (r: string) => void;
  setResolution: (r: string) => void;
  setDuration: (d: number) => void;
  setBatchCount: (n: number) => void;
  setGenerateAudio: (v: boolean) => void;
  setVideoTaskMode: (m: VideoTaskMode) => void;
  setPrompt: (p: string) => void;
  addReference: (dataUrl: string) => void;
  removeReference: (index: number) => void;
  reorderReferences: (newOrder: string[]) => void;
  addReferenceVideo: (ref: string) => void;
  removeReferenceVideo: (index: number) => void;

  // ui
  setRightTab: (t: RightTab) => void;
  setMobileHistoryOpen: (v: boolean) => void;
  setActiveId: (id: string | null) => void;
  setSearch: (s: string) => void;
  setFilterKind: (k: "all" | GenerationKind) => void;

  // data
  loadHistory: () => Promise<void>;
  loadMoreHistory: () => Promise<void>;
  /** Fetch the current scope's first page. Serves any cached copy immediately
   *  and revalidates behind it. */
  loadFeed: (opts?: { force?: boolean }) => Promise<void>;
  /** Refresh the folder/tab counts for the current scope. */
  loadCounts: () => Promise<void>;
  /** Reload the active project's conversation thread. */
  loadThread: () => Promise<void>;
  /** Merge buffered live arrivals into the visible feed. */
  flushPendingItems: () => void;
  setFeedPinned: (pinned: boolean) => void;
  setRightPanelOpen: (open: boolean) => void;
  /** Begin/stop the shared live-update poll. Idempotent; safe to call from an
   *  effect that may run twice under React strict mode. */
  startLiveUpdates: () => void;
  stopLiveUpdates: () => void;
  generate: () => Promise<void>;
  removeItem: (id: string) => Promise<void>;
  toggleFavorite: (id: string) => Promise<void>;
  retryTextToVideo: (id: string) => Promise<void>;
  editInComposer: (id: string) => void;
  cloneToComposer: (id: string) => Promise<void>;
  /** Re-run a generation exactly as it was, without going via the composer. */
  regenerate: (id: string) => Promise<void>;
  addReferenceFromUrl: (url: string) => Promise<void>;
  /** Pull a still frame out of a stored video and add it as a reference. */
  addReferenceFromVideo: (url: string, atSeconds?: number) => Promise<void>;

  // assets
  loadAssets: () => Promise<void>;
  saveAsset: (draft: AssetDraft) => Promise<Asset | null>;
  deleteAsset: (id: string) => Promise<void>;
  setAssetLibraryOpen: (v: boolean) => void;
  setEditingAsset: (a: Asset | "new" | null) => void;

  // projects
  loadProjects: () => Promise<void>;
  setActiveProject: (id: string | null) => void;
  setActiveFolder: (id: string | null) => void;
  createProject: (name: string) => Promise<void>;
  renameProject: (id: string, name: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  createFolder: (projectId: string, name: string) => Promise<void>;
  renameFolder: (projectId: string, folderId: string, name: string) => Promise<void>;
  deleteFolder: (projectId: string, folderId: string) => Promise<void>;
  moveItem: (itemId: string, folderId: string | null) => Promise<void>;

  // multi-select
  toggleSelect: (id: string) => void;
  selectAll: (ids: string[]) => void;
  clearSelection: () => void;
  moveItemsToProject: (
    ids: string[],
    projectId: string,
    folderId?: string | null
  ) => Promise<void>;

  // auth
  loadMe: () => Promise<void>;
  loadUsers: () => Promise<void>;
  logout: () => Promise<void>;
}

const polling = new Set<string>();

// ── scoped feed cache ───────────────────────────────────────────────────────
// Each library view (a project, a folder, Favourites, All assets, each with its
// own kind/search filter) is a separate server query, so flipping between them
// used to mean refetching from scratch. Keeping the last few keyed by scope
// makes that instant, and re-entry revalidates behind the cached copy rather
// than blanking it — the user sees content, then sees it get more correct.
/** Cached pages older than this revalidate on re-entry. Short, because history
 *  is team-wide: a teammate's generation should not stay invisible for long. */
const FEED_FRESH_MS = 30_000;

/** Rows loaded for the centre chat thread. Larger than a grid page because the
 *  thread is read top-to-bottom rather than scanned. */
const THREAD_PAGE_SIZE = 60;

// Monotonic request ids. Every async read stamps one and refuses to write if it
// is no longer the newest — the fix for a slow reply for folder A landing after
// a fast reply for folder B and painting the wrong contents.
let feedSeq = 0;
let countsSeq = 0;
let threadSeq = 0;

/** The scope the right panel is currently showing. */
function currentScope(s: AppState): FeedScope {
  return {
    tab: s.rightTab,
    projectId: s.activeProjectId,
    folderId: s.activeFolderId,
    kind: s.filterKind,
    q: s.search,
  };
}

/**
 * Apply a change to one row everywhere it is held.
 *
 * Rows now live in several places at once — the visible feed, the chat thread,
 * the buffered live arrivals, and every cached scope — so a favourite toggle or
 * a folder move that only updated `items` would be silently reverted the moment
 * the user switched tabs and came back to a stale cache entry. One helper keeps
 * that impossible.
 *
 * `patch` receives the current row so callers can merge conditionally.
 */
function patchEverywhere(
  set: (fn: (s: AppState) => Partial<AppState>) => void,
  id: string,
  patch: (item: GenerationItem) => GenerationItem
) {
  patchCached(id, patch);
  set((s) => ({
    items: s.items.map((i) => (i.id === id ? patch(i) : i)),
    threadItems: s.threadItems.map((i) => (i.id === id ? patch(i) : i)),
    pendingItems: s.pendingItems.map((i) => (i.id === id ? patch(i) : i)),
  }));
}

/** Remove a row from every pool, for deletes. */
function dropEverywhere(
  set: (fn: (s: AppState) => Partial<AppState>) => void,
  id: string
) {
  dropCached(id);
  set((s) => ({
    items: s.items.filter((i) => i.id !== id),
    threadItems: s.threadItems.filter((i) => i.id !== id),
    pendingItems: s.pendingItems.filter((i) => i.id !== id),
  }));
}

/** Drop every cached scope. Used when a bulk change (move-to-project, project
 *  delete) invalidates membership across scopes rather than one row's fields. */
function invalidateFeedCache() {
  clearFeedCache();
}

/** Look a row up across every pool. Callers act on an id the user clicked, and
 *  that row may be in the chat thread but not the current feed (or vice versa),
 *  so searching only `items` would make the action silently do nothing. */
function findItem(s: AppState, id: string): GenerationItem | undefined {
  return (
    s.items.find((i) => i.id === id) ??
    s.threadItems.find((i) => i.id === id) ??
    s.pendingItems.find((i) => i.id === id)
  );
}

/** Insert a freshly created row into the pools it belongs in. */
function insertNewItem(
  set: (fn: (s: AppState) => Partial<AppState>) => void,
  item: GenerationItem
) {
  set((s) => {
    const scope = currentScope(s);
    const patch: Partial<AppState> = {};

    // A new generation is always the newest row, so it goes at the head — no
    // re-sort needed, and none wanted: re-sorting the visible list is exactly
    // the movement this work is removing.
    if (matchesScope(item, scope)) {
      const items = [item, ...s.items.filter((i) => i.id !== item.id)];
      patch.items = items;
      writeCachedItems(scopeKey(scope), items);
    }
    if (item.projectId && item.projectId === s.activeProjectId) {
      patch.threadItems = [item, ...s.threadItems.filter((i) => i.id !== item.id)];
    }
    return patch;
  });
}

// ── shared live-update poll ─────────────────────────────────────────────────
// The per-item pollers below only ever attach to items THIS tab already knows
// about — startPolling is called on submit and from loadHistory, nowhere else.
// History is team-wide, so a job started in another tab, on another device, or
// by a teammate was never observed here and only appeared on a manual refresh.
//
// One shared poll fixes all of those at once, and costs a single request no
// matter how many jobs are in flight. It only OBSERVES: the per-item pollers
// still own execution (pollQueue is what posts /api/queue/execute), so nothing
// here can double-submit work.
const LIVE_MS_ACTIVE = 4000; // something is in flight — stay responsive
const LIVE_MS_IDLE = 20000; // nothing running — just watch for teammates

// A queued job is driven entirely by the tab that created it: pollQueue is what
// posts /api/queue/execute. Close that tab and nobody ever runs the job — and
// the server-side reaper only sweeps "running", so it sits queued forever,
// permanently inflating the position of everything queued behind it.
//
// Any client that can see a stale queued job can adopt it. lockJob is a
// conditional UPDATE (status='queued' only), so if several tabs adopt the same
// job exactly one wins and the losers get a clean 400 — adoption cannot
// double-run work.
//
// The delay is what makes this a fallback rather than a race: the owning tab
// polls every 1–3s, so it has long since claimed anything healthy. Adopting
// early would just add losing execute calls. Note that adopting is not the same
// as executing: pollQueue still respects queue position, so an adopted job that
// is legitimately waiting its turn is merely observed, not jumped ahead.
const ADOPT_QUEUED_AFTER_MS = 30_000;
let liveTimer: ReturnType<typeof setTimeout> | null = null;
let liveSince = 0;
let liveRunning = false;
let liveVisibilityHandler: (() => void) | null = null;

async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status === 401) {
    polling.clear();
    useStore.setState({ currentUser: null });
    if (typeof window !== "undefined" && window.location.pathname !== "/login") {
      window.location.replace("/login");
    }
    throw new Error("UNAUTHENTICATED");
  }
  return response;
}

export const useStore = create<AppState>((set, get) => ({
  view: "studio",

  // composer defaults (video by default, matching the reference)
  mode: "video",
  model: DEFAULTS.video.model,
  aspectRatio: DEFAULTS.video.aspectRatio,
  resolution: DEFAULTS.video.resolution,
  duration: DEFAULTS.video.duration,
  batchCount: 1,
  // On by default: the toggle existing but defaulting off meant the first
  // Seedance run after shipping it produced a silent video and looked broken.
  // Only ever reaches the provider on a model that has the field — the route
  // ANDs it with supportsAudio and setModel clamps it — so a default of true
  // is inert everywhere else.
  generateAudio: true,
  videoTaskMode: "generate",
  prompt: "",
  referenceImages: [],
  referenceVideos: [],

  items: [],
  hasMoreHistory: true,
  loading: true,
  refreshing: false,
  counts: EMPTY_COUNTS,
  feedKey: "",
  threadItems: [],
  threadLoading: true,
  pendingItems: [],
  feedPinned: true,
  rightPanelOpen: false,
  generating: false,
  rightTab: "project",
  mobileHistoryOpen: false,
  activeId: null,
  search: "",
  filterKind: "all",
  selectedIds: [],

  assets: [],
  assetsLoading: false,
  assetLibraryOpen: false,
  editingAsset: null,

  currentUser: null,
  usersById: {},

  projects: [],
  activeProjectId: null,
  activeFolderId: null,

  setView: (view) => set({ view }),

  setMode: (mode) => {
    const d = DEFAULTS[mode];
    set({
      mode,
      model: d.model,
      aspectRatio: d.aspectRatio,
      resolution: d.resolution,
      duration: "duration" in d ? d.duration : get().duration,
      videoTaskMode: "generate",
    });
  },
  setModel: (model) =>
    set((s) => {
      // Clamp duration/resolution/aspectRatio into the new model's valid
      // ranges by MEMBERSHIP, not just a max/min bound — Omni's durations
      // ([4,6,8]) don't contain today's default (5s), so a Math.min-style
      // clamp would silently leave 5s selected and the enqueue guard would
      // 400 on an untouched-defaults happy path. Also covers Higgsfield
      // Seedance (12s cap), Seedance Mini (720p cap), Omni (16:9/9:16 only).
      const durations = durationsForModel(model);
      const duration = durations.includes(s.duration)
        ? s.duration
        : durations[durations.length - 1];
      const resolutions = resolutionsForModel(model, s.mode);
      const resolution = resolutions.includes(s.resolution)
        ? s.resolution
        : resolutions[resolutions.length - 1];
      const aspectRatios = aspectRatiosForModel(model, s.mode);
      const aspectRatio = aspectRatios.includes(s.aspectRatio)
        ? s.aspectRatio
        : aspectRatios[0];
      // Same reasoning as the clamps above: a setting the chosen model has no
      // field for must not survive the switch, or the composer shows an
      // enabled toggle whose value the provider will silently discard.
      const generateAudio = supportsAudio(model) ? s.generateAudio : false;
      const referenceVideos = supportsVideoReference(model) ? s.referenceVideos : [];
      // Same reasoning: Edit/Extend only exist on Seedance 2.5, so switching
      // away must not leave the composer claiming a mode the new model has
      // no such task type for.
      const videoTaskMode = supportsVideoEditExtend(model) ? s.videoTaskMode : "generate";
      return { model, duration, resolution, aspectRatio, generateAudio, referenceVideos, videoTaskMode };
    }),
  setAspectRatio: (aspectRatio) => set({ aspectRatio }),
  setResolution: (resolution) => set({ resolution }),
  setDuration: (duration) => set({ duration }),
  setBatchCount: (batchCount) => set({ batchCount: Math.min(4, Math.max(1, batchCount)) }),
  setGenerateAudio: (generateAudio) => set({ generateAudio }),
  setVideoTaskMode: (videoTaskMode) => set({ videoTaskMode }),
  setPrompt: (prompt) => set({ prompt }),
  addReference: (dataUrl) =>
    set((s) => ({ referenceImages: [...s.referenceImages, dataUrl] })),
  removeReference: (index) =>
    set((s) => ({
      referenceImages: s.referenceImages.filter((_, i) => i !== index),
    })),
  // Drag-reorder from the composer. Diffs old vs. new position per image
  // (by value — reference images are treated as distinct, so an exact
  // byte-identical duplicate upload is the one case this can misnumber) and
  // renumbers any @imgN already typed in the prompt so it keeps pointing at
  // the same image rather than silently drifting to whatever else lands in
  // that slot.
  reorderReferences: (newOrder) =>
    set((s) => ({
      referenceImages: newOrder,
      prompt: renumberImgMentions(
        s.prompt,
        s.referenceImages.map((img) => newOrder.indexOf(img))
      ),
    })),
  addReferenceVideo: (ref) =>
    set((s) =>
      s.referenceVideos.includes(ref) ||
      s.referenceVideos.length >= MAX_REFERENCE_VIDEOS
        ? {}
        : { referenceVideos: [...s.referenceVideos, ref] }
    ),
  removeReferenceVideo: (index) =>
    set((s) => ({
      referenceVideos: s.referenceVideos.filter((_, i) => i !== index),
    })),

  setRightTab: (rightTab) => set({ rightTab }),
  setMobileHistoryOpen: (mobileHistoryOpen) => set({ mobileHistoryOpen }),
  setActiveId: (activeId) => set({ activeId }),
  setSearch: (search) => set({ search }),
  setFilterKind: (filterKind) => set({ filterKind }),

  loadHistory: async () => {
    // Everything the first paint needs: the right panel's feed, its counts,
    // and the centre chat thread. Fired in parallel — they hit different
    // indexes and none depends on another's result.
    await Promise.all([
      get().loadFeed({ force: true }),
      get().loadCounts(),
      get().loadThread(),
    ]);
  },

  loadFeed: async ({ force = false } = {}) => {
    const scope = currentScope(get());
    // The project tab before projects have loaded. Requesting this scope would
    // omit projectId entirely and so return the whole library — every asset in
    // the workspace, presented as if it belonged to one project.
    if (scope.tab === "project" && !scope.projectId) {
      set({
        items: [],
        hasMoreHistory: false,
        loading: false,
        refreshing: false,
        feedKey: scopeKey(scope),
      });
      return;
    }
    const key = scopeKey(scope);
    const cached = getCached(key);

    // Serve the cache first. Re-entering a scope is the common case (clicking
    // between folders, flipping tabs), and re-rendering identical rows behind a
    // skeleton is both slower to read and a layout jump for no information.
    if (cached && !force) {
      set({
        items: cached.items,
        hasMoreHistory: cached.nextCursor !== null,
        loading: false,
        pendingItems: [],
        feedKey: key,
      });
      if (Date.now() - cached.at < FEED_FRESH_MS) return;
    }

    const hasSomethingToShow = Boolean(cached);
    set(
      hasSomethingToShow
        ? { refreshing: true, feedKey: key }
        : { loading: true, refreshing: false, items: [], pendingItems: [], feedKey: key }
    );

    // Every in-flight feed request carries a sequence number; only the newest
    // may write. Without this, clicking through folders faster than the network
    // answers lets an earlier reply land last and paint the wrong folder's
    // contents under the right folder's highlight.
    const seq = ++feedSeq;
    try {
      const params = historyFilterToParams(scopeToQuery(scope));
      params.set("limit", String(HISTORY_PAGE_SIZE));
      const res = await apiFetch(`/api/history?${params}`, { cache: "no-store" });
      const json = await res.json();
      if (seq !== feedSeq) return; // superseded

      const items: GenerationItem[] = json.items ?? [];
      const nextCursor: string | null = json.nextCursor ?? null;
      putFeedCache(key, { items, nextCursor, at: Date.now() });
      set({
        items,
        hasMoreHistory: nextCursor !== null,
        loading: false,
        refreshing: false,
        pendingItems: [],
        feedKey: key,
      });
      // Resume driving anything still in flight that this page revealed.
      for (const it of items) startPolling(it, set, get);
    } catch {
      if (seq !== feedSeq) return;
      set({ loading: false, refreshing: false });
    }
  },

  loadMoreHistory: async () => {
    const s = get();
    if (!s.hasMoreHistory) return;
    const scope = currentScope(s);
    const key = scopeKey(scope);
    const cached = getCached(key);
    const cursor = cached?.nextCursor;
    if (!cursor) return;

    const seq = feedSeq; // appends belong to the scope that is current now
    try {
      const params = historyFilterToParams(scopeToQuery(scope));
      params.set("limit", String(HISTORY_PAGE_SIZE));
      params.set("cursor", cursor);
      const res = await apiFetch(`/api/history?${params}`, { cache: "no-store" });
      const json = await res.json();
      if (seq !== feedSeq) return; // scope changed while we were paging

      const newItems: GenerationItem[] = json.items ?? [];
      const nextCursor: string | null = json.nextCursor ?? null;

      set((st) => {
        // Dedupe by id. A row can legitimately appear in two pages if it was
        // favourited (Favourites is ordered by favoritedAt, which moves) or
        // moved between projects mid-scroll; React would then throw on the
        // duplicate key.
        const seen = new Set(st.items.map((i) => i.id));
        const appended = [...st.items, ...newItems.filter((i) => !seen.has(i.id))];
        putFeedCache(key, { items: appended, nextCursor, at: Date.now() });
        return { items: appended, hasMoreHistory: nextCursor !== null };
      });
      for (const it of newItems) startPolling(it, set, get);
    } catch (e) {
      console.error("Failed to load more history:", e);
    }
  },

  loadCounts: async () => {
    const scope = currentScope(get());
    const seq = ++countsSeq;
    try {
      const params = historyFilterToParams({
        projectId: scope.projectId ?? undefined,
        kind: scope.kind,
        q: scope.q,
      });
      const res = await apiFetch(`/api/history/counts?${params}`, {
        cache: "no-store",
      });
      const json = await res.json();
      if (seq !== countsSeq) return;
      set({
        counts: {
          project: json.project ?? EMPTY_COUNTS.project,
          allAssets: Number(json.allAssets ?? 0),
          favorites: Number(json.favorites ?? 0),
        },
      });
    } catch {
      /* counts are decoration — a failure leaves the last known numbers */
    }
  },

  loadThread: async () => {
    const projectId = get().activeProjectId;
    if (!projectId) {
      set({ threadItems: [], threadLoading: false });
      return;
    }
    const seq = ++threadSeq;
    set({ threadLoading: true });
    try {
      const params = historyFilterToParams({ projectId });
      params.set("limit", String(THREAD_PAGE_SIZE));
      const res = await apiFetch(`/api/history?${params}`, { cache: "no-store" });
      const json = await res.json();
      if (seq !== threadSeq) return;
      set({ threadItems: json.items ?? [], threadLoading: false });
      for (const it of json.items ?? []) startPolling(it, set, get);
    } catch {
      if (seq !== threadSeq) return;
      set({ threadLoading: false });
    }
  },

  flushPendingItems: () => {
    set((s) => {
      if (!s.pendingItems.length) return {};
      const scope = currentScope(s);
      const byId = new Map(s.items.map((i) => [i.id, i]));
      for (const inc of s.pendingItems) byId.set(inc.id, inc);
      const items = Array.from(byId.values()).sort((a, b) =>
        compareInScope(a, b, scope)
      );
      writeCachedItems(scopeKey(scope), items);
      return { items, pendingItems: [] };
    });
  },

  setRightPanelOpen: (rightPanelOpen) => set({ rightPanelOpen }),

  setFeedPinned: (feedPinned) => {
    // The grid calls this on every scroll event. Writing unconditionally would
    // notify every store subscriber on every frame of a scroll, which is a lot
    // of wasted rendering for a boolean that changes twice per gesture.
    if (get().feedPinned === feedPinned) return;
    set({ feedPinned });
    // Returning to the top is an implicit "show me what arrived".
    if (feedPinned && get().pendingItems.length) get().flushPendingItems();
  },

  startLiveUpdates: () => {
    if (liveRunning) return; // idempotent — strict mode mounts effects twice
    liveRunning = true;
    // Start the watermark slightly in the past so a job that finished during
    // the initial page load isn't missed in the gap before the first poll.
    liveSince = Date.now() - 60_000;
    if (typeof document !== "undefined" && !liveVisibilityHandler) {
      // Returning to a backgrounded tab is exactly when the view is most
      // stale, so catch up immediately rather than waiting out the interval.
      liveVisibilityHandler = () => {
        if (!document.hidden && liveRunning) {
          scheduleLive(set, get, 0);
        }
      };
      document.addEventListener("visibilitychange", liveVisibilityHandler);
    }
    scheduleLive(set, get, LIVE_MS_ACTIVE);
  },

  stopLiveUpdates: () => {
    liveRunning = false;
    if (liveTimer) {
      clearTimeout(liveTimer);
      liveTimer = null;
    }
    if (typeof document !== "undefined" && liveVisibilityHandler) {
      document.removeEventListener("visibilitychange", liveVisibilityHandler);
      liveVisibilityHandler = null;
    }
  },

  generate: async () => {
    const s = get();
    const prompt = s.prompt.trim();
    if (!prompt || s.generating) return;

    set({ generating: true });
    const endpoint =
      s.mode === "image" ? "/api/generate/image" : "/api/generate/video";
    const videoTaskMode = s.mode === "video" ? s.videoTaskMode : "generate";
    const payload = {
      prompt,
      model: s.model,
      // Edit/Extend require BytePlus's ratio:"adaptive" — sent from here
      // rather than left to the enqueue route so the STORED row (and
      // therefore the library card) reflects what was actually requested,
      // not the composer's last manual aspect-ratio pick for this model.
      aspectRatio: videoTaskMode === "generate" ? s.aspectRatio : "adaptive",
      resolution: s.resolution,
      // Edit's duration is forced to "match the source" by the provider
      // layer regardless of what's sent (see providers/seedance.ts), so
      // omitting it here keeps the stored row honest instead of recording a
      // number that was never actually requested.
      duration: videoTaskMode === "edit" ? undefined : s.duration,
      referenceImages: s.referenceImages,
      referenceVideos: s.referenceVideos,
      generateAudio: s.generateAudio,
      videoTaskMode,
      projectId: s.activeProjectId ?? undefined,
      folderId: s.activeFolderId ?? undefined,
    };

    try {
      // Batch: enqueue N independent jobs with the same payload. The queue's
      // per-kind concurrency cap decides how many actually run at once.
      const count = Math.min(4, Math.max(1, s.batchCount || 1));
      for (let i = 0; i < count; i++) {
        const res = await apiFetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        let item: GenerationItem;
        try {
          item = await res.json();
        } catch {
          throw new Error(`Server error (${res.status}): the server returned an empty or invalid response.`);
        }
        if (!res.ok) {
          throw new Error(item.error || `Server error: ${res.status}`);
        }
        if (item?.id) {
          // Stay on the tab the user chose. Forcing "history" (All assets) on
          // every submit yanked them out of the project they were working in,
          // which is also the scope the new item was generated into.
          insertNewItem(set, item);
          set({ prompt: "" });
          startPolling(item, set, get);
        }
      }
      void get().loadCounts();
    } catch (e: any) {
      console.error("Generation request failed:", e);
      alert(e.message || "Failed to start generation.");
    } finally {
      set({ generating: false });
    }
  },

  removeItem: async (id) => {
    dropEverywhere(set, id);
    set((s) => ({ activeId: s.activeId === id ? null : s.activeId }));
    void get().loadCounts();
    try {
      await apiFetch(`/api/history?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    } catch {
      /* ignore */
    }
  },

  toggleFavorite: async (id) => {
    const item = findItem(get(), id);
    if (!item) return;

    const nextFavorite = !item.isFavorite;
    const favoritedAt = nextFavorite ? Date.now() : undefined;
    patchEverywhere(set, id, (i) => ({
      ...i,
      isFavorite: nextFavorite,
      favoritedAt,
    }));
    // Un-starring while looking at Favourites is a membership change, not just
    // a field change: the row no longer belongs in this scope.
    if (!nextFavorite && get().rightTab === "favorites") dropEverywhere(set, id);
    void get().loadCounts();

    try {
      const res = await apiFetch("/api/history", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, isFavorite: nextFavorite }),
      });
      if (!res.ok) throw new Error("Favourite update failed.");
      const updated: GenerationItem = await res.json();
      if (updated?.id) patchEverywhere(set, updated.id, (i) => ({ ...i, ...updated }));
    } catch {
      patchEverywhere(set, id, (i) => ({
        ...i,
        isFavorite: item.isFavorite,
        favoritedAt: item.favoritedAt,
      }));
      // The optimistic removal above has to come back too.
      if (!nextFavorite && get().rightTab === "favorites") void get().loadFeed({ force: true });
      void get().loadCounts();
    }
  },

  retryTextToVideo: async (id) => {
    const item = findItem(get(), id);
    if (!item || get().generating) return;
    // Drop @tags so leftover references don't confuse a no-image generation.
    const cleanPrompt = item.prompt
      .replace(/@[\w-]+/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (!cleanPrompt) return;

    set({ generating: true });
    try {
      const res = await apiFetch("/api/generate/video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: cleanPrompt,
          model: item.model,
          aspectRatio: item.aspectRatio,
          resolution: item.resolution,
          duration: item.duration,
          referenceImages: [],
          projectId: item.projectId,
          folderId: item.folderId,
        }),
      });
      const newItem: GenerationItem = await res.json();
      if (newItem?.id) {
        insertNewItem(set, newItem);
        if (
          newItem.kind === "video" &&
          (newItem.status === "running" || newItem.status === "queued")
        ) {
          pollVideo(newItem.id, set, get);
        }
      }
    } catch {
      /* ignore */
    } finally {
      set({ generating: false });
    }
  },

  editInComposer: (id) => {
    const item = findItem(get(), id);
    if (!item) return;
    set({ mode: item.kind, prompt: item.prompt });
  },

  addReferenceFromUrl: async (url) => {
    // Fetch a generated image and add it to the composer as a reference (data
    // URL so every provider works) — enables the hero-first crowd workflow.
    // Generated images can be full-resolution (well over Vercel's 4.5MB body
    // limit once base64-encoded), so this must go through the same downscale
    // budget ladder as file uploads (addImageFiles in PromptComposer.tsx) —
    // skipping it previously produced an oversized generate() payload that
    // Vercel rejected with a non-JSON 413, surfacing as "server returned an
    // empty or invalid response".
    try {
      const res = await fetch(inlineMediaUrl(url));
      const blob = await res.blob();
      const dataUrl = await encodeBlobWithBudget(blob);
      get().addReference(dataUrl);
    } catch (e) {
      console.error("Failed to add reference from URL:", e);
    }
  },

  regenerate: async (id) => {
    // Reuses cloneToComposer rather than rebuilding the payload: it already
    // restores model/ratio/resolution/duration/audio AND re-fetches the stored
    // reference images as data URLs, which a fresh submit needs. Then just
    // submit what it loaded.
    if (get().generating) return;
    await get().cloneToComposer(id);
    if (!get().prompt.trim()) return;
    await get().generate();
  },

  addReferenceFromVideo: async (url, atSeconds) => {
    // No provider here accepts an uploaded video, so a frame is how a clip
    // becomes usable as a reference at all. Decoded in the browser — see
    // lib/video-frame.ts for why this cannot happen server-side.
    try {
      const { extractFrame } = await import("./video-frame");
      const { dataUrl } = await extractFrame(inlineMediaUrl(url), atSeconds);
      get().addReference(dataUrl);
    } catch (e: any) {
      console.error("Failed to take a frame from video:", e);
      alert(e?.message || "Could not read a frame from this video.");
    }
  },

  cloneToComposer: async (id) => {
    const item = findItem(get(), id);
    if (!item) return;
    set({
      mode: item.kind,
      model: item.model,
      aspectRatio: item.aspectRatio,
      resolution: item.resolution ?? get().resolution,
      duration: item.duration ?? get().duration,
      generateAudio: item.generateAudio === true && supportsAudio(item.model),
      videoTaskMode: supportsVideoEditExtend(item.model)
        ? item.videoTaskMode ?? "generate"
        : "generate",
      prompt: item.prompt,
      referenceImages: [],
    });
    // Restore the stored reference images as data URLs so every provider works.
    const paths = item.referenceImages ?? [];
    if (paths.length) {
      const dataUrls = await Promise.all(
        paths.map(async (p) => {
          try {
            const res = await fetch(inlineMediaUrl(p));
            const blob = await res.blob();
            return await new Promise<string>((resolve) => {
              const r = new FileReader();
              r.onload = () => resolve(r.result as string);
              r.readAsDataURL(blob);
            });
          } catch {
            return null;
          }
        })
      );
      set({ referenceImages: dataUrls.filter((d): d is string => !!d) });
    }
  },

  loadAssets: async () => {
    set({ assetsLoading: true });
    try {
      const res = await apiFetch("/api/assets", { cache: "no-store" });
      const json = await res.json();
      set({ assets: json.assets ?? [] });
    } catch {
      /* ignore — library just stays empty */
    } finally {
      // finally, not the try body: a failed fetch must still clear the
      // spinner, or the panel spins forever on a network blip.
      set({ assetsLoading: false });
    }
  },

  saveAsset: async (draft) => {
    try {
      const res = await apiFetch("/api/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const asset: Asset = await res.json();
      if (!asset?.id) return null;
      set((s) => ({
        assets: [asset, ...s.assets.filter((a) => a.id !== asset.id)],
        editingAsset: null,
      }));
      return asset;
    } catch {
      return null;
    }
  },

  deleteAsset: async (id) => {
    set((s) => ({ assets: s.assets.filter((a) => a.id !== id) }));
    try {
      await apiFetch(`/api/assets?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    } catch {
      /* ignore */
    }
  },

  setAssetLibraryOpen: (assetLibraryOpen) => set({ assetLibraryOpen }),
  setEditingAsset: (editingAsset) => set({ editingAsset }),

  loadProjects: async () => {
    try {
      // GET ensures a default project server-side (atomic — no duplicate races).
      const res = await apiFetch("/api/projects", { cache: "no-store" });
      const json = await res.json();
      const projects: Project[] = json.projects ?? [];
      set((s) => ({
        projects,
        activeProjectId:
          s.activeProjectId && projects.some((p) => p.id === s.activeProjectId)
            ? s.activeProjectId
            : projects[0]?.id ?? null,
      }));
    } catch {
      /* ignore */
    }
  },

  // The subscription at the bottom of this file watches these and refetches the
  // feed, counts and thread — so switching project or folder is one state write
  // here, not a fetch every caller has to remember to make.
  setActiveProject: (id) => set({ activeProjectId: id, activeFolderId: null }),
  setActiveFolder: (id) => set({ activeFolderId: id }),

  createProject: async (name) => {
    const res = await apiFetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "createProject", name }),
    });
    const json = await res.json();
    if (json.projects) {
      set({
        projects: json.projects,
        activeProjectId: json.project?.id ?? get().activeProjectId,
        activeFolderId: null,
      });
    }
  },

  renameProject: async (id, name) => {
    const res = await apiFetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "renameProject", projectId: id, name }),
    });
    const json = await res.json();
    if (json.projects) set({ projects: json.projects });
  },

  deleteProject: async (id) => {
    const res = await apiFetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "deleteProject", projectId: id }),
    });
    const json = await res.json();
    if (json.projects) {
      const projects: Project[] = json.projects;
      set((s) => ({
        projects,
        activeProjectId:
          s.activeProjectId === id ? projects[0]?.id ?? null : s.activeProjectId,
        activeFolderId: s.activeProjectId === id ? null : s.activeFolderId,
      }));
      // Items got orphaned server-side. That is a membership change across
      // every project-scoped view at once, so refetch rather than trying to
      // patch each cached scope into a consistent state.
      invalidateFeedCache();
      void get().loadFeed({ force: true });
      void get().loadCounts();
      void get().loadThread();
    }
  },

  createFolder: async (projectId, name) => {
    const res = await apiFetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "createFolder", projectId, name }),
    });
    const json = await res.json();
    if (json.projects) {
      set({ projects: json.projects });
      if (json.folder?.id) set({ activeFolderId: json.folder.id });
    }
  },

  renameFolder: async (projectId, folderId, name) => {
    const res = await apiFetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "renameFolder", projectId, folderId, name }),
    });
    const json = await res.json();
    if (json.projects) set({ projects: json.projects });
  },

  deleteFolder: async (projectId, folderId) => {
    const res = await apiFetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "deleteFolder", projectId, folderId }),
    });
    const json = await res.json();
    if (json.projects) {
      set((s) => ({
        projects: json.projects,
        activeFolderId: s.activeFolderId === folderId ? null : s.activeFolderId,
      }));
      // Its items became unsorted — a membership change for both the folder's
      // own scope and the project's unsorted scope.
      invalidateFeedCache();
      void get().loadFeed({ force: true });
      void get().loadCounts();
    }
  },

  moveItem: async (itemId, folderId) => {
    const projectId = get().activeProjectId ?? undefined;
    patchEverywhere(set, itemId, (i) => ({
      ...i,
      projectId: projectId ?? i.projectId,
      folderId: folderId ?? undefined,
    }));
    // Dragging an item into a folder means it leaves whichever folder view is
    // on screen, so remove it from the current feed if it no longer qualifies.
    set((s) => {
      const scope = currentScope(s);
      const moved = s.items.find((i) => i.id === itemId);
      if (!moved || matchesScope(moved, scope)) return {};
      const items = s.items.filter((i) => i.id !== itemId);
      writeCachedItems(scopeKey(scope), items);
      return { items };
    });
    void get().loadCounts();
    try {
      await apiFetch("/api/history", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: itemId, projectId, folderId }),
      });
    } catch {
      // The optimistic move may have been wrong — resync rather than leaving
      // the item shown somewhere the server disagrees with.
      invalidateFeedCache();
      void get().loadFeed({ force: true });
      void get().loadCounts();
    }
  },

  toggleSelect: (id) =>
    set((s) => ({
      selectedIds: s.selectedIds.includes(id)
        ? s.selectedIds.filter((x) => x !== id)
        : [...s.selectedIds, id],
    })),
  selectAll: (ids) => set({ selectedIds: ids }),
  clearSelection: () => set({ selectedIds: [] }),

  moveItemsToProject: async (ids, projectId, folderId = null) => {
    if (!ids.length) return;
    for (const id of ids) {
      patchEverywhere(set, id, (i) => ({
        ...i,
        projectId,
        folderId: folderId ?? undefined,
      }));
    }
    set({ selectedIds: [] });
    try {
      await Promise.all(
        ids.map((id) =>
          apiFetch("/api/history", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, projectId, folderId }),
          })
        )
      );
    } catch {
      /* fall through to the resync below */
    }
    // A bulk move changes membership in several scopes at once (source project,
    // destination project, every folder view under both). Cheaper and more
    // honest to re-ask the server than to reconcile each cached scope.
    invalidateFeedCache();
    await Promise.all([
      get().loadFeed({ force: true }),
      get().loadCounts(),
      get().loadThread(),
    ]);
  },

  loadMe: async () => {
    try {
      const res = await apiFetch("/api/auth/me", { cache: "no-store" });
      const json = await res.json();
      if (json.user) set({ currentUser: json.user });
      else window.location.href = "/login";
    } catch {
      /* ignore */
    }
  },

  loadUsers: async () => {
    try {
      const res = await apiFetch("/api/users", { cache: "no-store" });
      const json = await res.json();
      const map: Record<string, PublicUser> = {};
      for (const u of json.users ?? []) map[u.id] = u;
      set({ usersById: map });
    } catch {
      /* ignore */
    }
  },

  logout: async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    window.location.href = "/login";
  },
}));

function pollVideo(
  id: string,
  set: (fn: (s: AppState) => Partial<AppState>) => void,
  get: () => AppState
) {
  if (polling.has(id)) return;
  polling.add(id);

  const tick = async () => {
    try {
      const res = await apiFetch(
        `/api/generate/video/status?id=${encodeURIComponent(id)}`,
        { cache: "no-store" }
      );
      const item: GenerationItem = await res.json();
      if (item?.id) {
        patchEverywhere(set, item.id, (i) => ({ ...i, ...item }));
        if (item.status === "succeeded" || item.status === "failed") {
          polling.delete(id);
          return;
        }
      }
    } catch {
      /* keep trying */
    }
    if (polling.has(id)) setTimeout(tick, 4000);
  };

  setTimeout(tick, 3000);
}

/**
 * Merge server rows into the store without losing local truth — and without
 * moving anything the user is currently looking at.
 *
 * Rules, each guarding a specific way this could go wrong:
 *  - Only overwrite when the incoming row is strictly newer by updatedAt, so a
 *    slow live poll can't clobber a fresher result that a per-item poller just
 *    wrote from /api/queue/execute.
 *  - Preserve queueNote, which is client-only and transient (it never round
 *    trips through the DB), but drop it once the item leaves the queue.
 *  - Only consider rows that belong in the scope on screen. The feed is a
 *    server-filtered query now, so splicing in a row from another project would
 *    show something a refetch immediately removes.
 *  - Only INSERT rows newer than the oldest page we've loaded, or still in
 *    flight. items is a paginated window; splicing an old row into the middle
 *    of it creates a hole that pagination then duplicates or skips.
 *  - **Never insert above the viewport while the user is scrolled.** An update
 *    to a row already on screen is a repaint in place and always applied; a new
 *    row is an insertion at the head, which shifts every card below it. That
 *    shift is the "it keeps moving around while I scroll" complaint, so new
 *    arrivals are buffered into `pendingItems` and surfaced as a count the user
 *    can act on. When the grid is at the top (`feedPinned`) there is nothing
 *    above to displace, so they go straight in.
 */
function mergeLiveItems(
  incoming: GenerationItem[],
  set: (fn: (s: AppState) => Partial<AppState>) => void
) {
  if (!incoming.length) return;
  set((s) => {
    const scope = currentScope(s);
    const byId = new Map(s.items.map((i) => [i.id, i]));
    const oldestLoaded = s.items.length
      ? Math.min(...s.items.map((i) => i.createdAt))
      : 0;
    const pendingById = new Map(s.pendingItems.map((i) => [i.id, i]));
    let changed = false;
    let pendingChanged = false;

    for (const inc of incoming) {
      const cur = byId.get(inc.id);
      if (cur) {
        if (inc.updatedAt > cur.updatedAt) {
          const merged = {
            ...cur,
            ...inc,
            queueNote: inc.status === "queued" ? cur.queueNote : undefined,
          };
          // An in-place update can still change membership — a job that
          // finished into another folder, say. Drop it rather than show a row
          // this view would not have returned.
          if (matchesScope(merged, scope)) byId.set(inc.id, merged);
          else byId.delete(inc.id);
          changed = true;
        }
        continue;
      }

      if (!matchesScope(inc, scope)) continue;
      const inFlight = inc.status === "queued" || inc.status === "running";
      if (!inFlight && inc.createdAt <= oldestLoaded) continue;

      if (s.feedPinned) {
        byId.set(inc.id, inc);
        changed = true;
      } else if (!pendingById.has(inc.id) || pendingById.get(inc.id)!.updatedAt < inc.updatedAt) {
        pendingById.set(inc.id, inc);
        pendingChanged = true;
      }
    }

    const patch: Partial<AppState> = {};
    if (changed) {
      const items = Array.from(byId.values()).sort((a, b) =>
        compareInScope(a, b, scope)
      );
      patch.items = items;
      writeCachedItems(scopeKey(scope), items);
    }
    if (pendingChanged) patch.pendingItems = Array.from(pendingById.values());
    return patch;
  });
}

/**
 * Take over queued jobs nobody is driving.
 *
 * `polling` is per-tab, so "not in our polling set" means this tab is not
 * driving it — which is the whole point: the tab that WAS driving it may be
 * gone. See ADOPT_QUEUED_AFTER_MS for why staleness is required first, and why
 * concurrent adoption by several tabs is safe.
 *
 * Uses the server's clock (`now`) rather than Date.now() for the staleness
 * test, so a client whose clock runs fast can't decide every fresh job is
 * already orphaned.
 *
 * Running jobs are left alone: an image job runs inside its originating
 * request and cannot be resumed by anyone, and a running video is already
 * submitted remotely — the live feed alone will carry it to completion.
 */
function adoptOrphanedJobs(
  incoming: GenerationItem[],
  serverNow: unknown,
  set: (fn: (s: AppState) => Partial<AppState>) => void,
  get: () => AppState
) {
  const now = typeof serverNow === "number" ? serverNow : Date.now();
  for (const item of incoming) {
    if (item.status !== "queued") continue;
    if (polling.has(item.id)) continue;
    if (now - item.updatedAt < ADOPT_QUEUED_AFTER_MS) continue;
    startPolling(item, set, get);
  }
}

/** One poll of the live feed, then reschedule at a cadence that matches how
 *  much is actually happening. */
async function liveTick(
  set: (fn: (s: AppState) => Partial<AppState>) => void,
  get: () => AppState
) {
  if (!liveRunning) return;
  // A hidden tab is throttled by the browser to roughly one timer per minute
  // anyway, and nobody is looking. Skip the request and let the
  // visibilitychange handler fire an immediate catch-up poll on return.
  if (typeof document !== "undefined" && document.hidden) {
    scheduleLive(set, get, LIVE_MS_IDLE);
    return;
  }
  try {
    const res = await apiFetch(
      `/api/history/updates?since=${encodeURIComponent(String(liveSince))}`,
      { cache: "no-store" }
    );
    const data = await res.json();
    if (Array.isArray(data.items)) {
      mergeLiveItems(data.items, set);
      adoptOrphanedJobs(data.items, data.now, set, get);
    }
    // Watermark comes from the server so client clock skew can't skip changes.
    if (typeof data.now === "number") liveSince = data.now;
  } catch {
    /* transient — the next tick retries, and 401 already redirects in apiFetch */
  }
  const busy = get().items.some(
    (i) => i.status === "queued" || i.status === "running"
  );
  scheduleLive(set, get, busy ? LIVE_MS_ACTIVE : LIVE_MS_IDLE);
}

function scheduleLive(
  set: (fn: (s: AppState) => Partial<AppState>) => void,
  get: () => AppState,
  ms: number
) {
  if (!liveRunning) return;
  if (liveTimer) clearTimeout(liveTimer);
  liveTimer = setTimeout(() => liveTick(set, get), ms);
}

/** Route a fresh/resumed item to the right poller: queued jobs of BOTH kinds
 *  wait in the capped queue (pollQueue executes at position 0); running
 *  videos are already submitted remotely and just need status polling. */
function startPolling(
  item: GenerationItem,
  set: (fn: (s: AppState) => Partial<AppState>) => void,
  get: () => AppState
) {
  if (item.status === "queued") {
    pollQueue(item.id, set, get);
  } else if (item.status === "running") {
    if (item.kind === "video") {
      pollVideo(item.id, set, get);
    } else {
      // Images execute synchronously inside /api/queue/execute; if that
      // request was interrupted (reload, backgrounded tab, network blip)
      // after the job flipped to "running" server-side, nothing else will
      // ever tell this client it finished. /api/queue/status reports the
      // row's real status regardless of queue position, so reuse it here
      // to wait out the remaining execution.
      pollQueue(item.id, set, get);
    }
  }
}

function pollQueue(
  id: string,
  set: (fn: (s: AppState) => Partial<AppState>) => void,
  get: () => AppState
) {
  if (polling.has(id)) return;
  polling.add(id);

  const tick = async () => {
    try {
      const res = await apiFetch(`/api/queue/status?id=${encodeURIComponent(id)}`, {
        cache: "no-store",
      });
      const data = await res.json();

      if (data.status === "queued" && data.position === 0) {
        // It's our turn!
        const execRes = await apiFetch(`/api/queue/execute`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
        const finalItem: GenerationItem = await execRes.json();
        if (finalItem?.id) {
          patchEverywhere(set, finalItem.id, (i) => ({
            ...i,
            ...finalItem,
            queueNote: undefined,
          }));
          // Cost lands with the finished row, and the counts endpoint is what
          // the folder rail reads.
          void get().loadCounts();
        }
        polling.delete(id);
        // Videos come back "running" with a provider taskId — hand off to
        // the remote-render status poller.
        if (finalItem?.kind === "video" && finalItem.status === "running") {
          pollVideo(finalItem.id, set, get);
        }
        return; // done
      } else if (data.heldForBudget) {
        // Held by the spend gate, not by a backlog. Surface why, and pace the
        // next poll off the server's hint — the window frees on a schedule the
        // server knows and the client can't guess, so polling every 3s here
        // would be pure noise (and each poll is a DB round trip).
        patchEverywhere(set, id, (i) => ({ ...i, queueNote: data.heldReason }));
        if (polling.has(id)) {
          setTimeout(tick, Math.min(Math.max(Number(data.retryAfterMs) || 5000, 5000), 60_000));
        }
        return;
      } else if (data.status === "succeeded" || data.status === "failed") {
        // Finished (or failed) since our last check — merge the real item
        // (url/cost/etc.) rather than just noting the status string, so a
        // client that resumed polling on a "running" item actually sees it
        // complete without needing a manual refresh.
        if (data.item?.id) {
          patchEverywhere(set, data.item.id, (i) => ({
            ...i,
            ...data.item,
            queueNote: undefined,
          }));
        }
        polling.delete(id);
        return;
      }
      // Still queued and position > 0, wait and poll again
    } catch {
      /* keep trying */
    }
    if (polling.has(id)) setTimeout(tick, 3000);
  };

  setTimeout(tick, 1000);
}

// ── composer draft + UI-state persistence ────────────────────────────────────
// The prompt is written on a short debounce (it changes per keystroke); the
// reference images are written only when they actually change (they can be
// multi-MB data URLs — serializing them per keystroke would jank typing);
// composer settings and panel/tab state are tiny and written on change.
const DRAFT_PROMPT_KEY = "veevee-draft-prompt-v1";
const DRAFT_REFS_KEY = "veevee-draft-refs-v1";
const DRAFT_SETTINGS_KEY = "veevee-draft-settings-v1";

/** Restore the locally cached composer draft (prompt + reference images) and
 *  UI state (mode/model/settings, panel tab, active project/folder) once at
 *  mount, so a refresh doesn't reset the user's workspace. Settings restore
 *  always; prompt/refs only when the composer is empty. Every restored value
 *  is validated against the current catalog so a stale cache can't produce an
 *  invalid combination. */
export function restoreComposerDraft() {
  try {
    const rawSettings = localStorage.getItem(DRAFT_SETTINGS_KEY);
    if (rawSettings) {
      const d = JSON.parse(rawSettings);
      const patch: Record<string, unknown> = {};
      const mode: GenerationKind | undefined =
        d.mode === "image" || d.mode === "video" ? d.mode : undefined;
      if (mode) patch.mode = mode;
      const effMode = mode ?? useStore.getState().mode;
      if (MODELS.some((m) => m.name === d.model && m.kind === effMode)) {
        patch.model = d.model;
      }
      const effModel = (patch.model as string) ?? DEFAULTS[effMode].model;
      if (aspectRatiosForModel(effModel, effMode).includes(d.aspectRatio)) {
        patch.aspectRatio = d.aspectRatio;
      }
      if (resolutionsForModel(effModel, effMode).includes(d.resolution)) {
        patch.resolution = d.resolution;
      }
      if (durationsForModel(effModel).includes(d.duration)) {
        patch.duration = d.duration;
      }
      if ([1, 2, 3, 4].includes(d.batchCount)) {
        patch.batchCount = d.batchCount;
      }
      // Validated against the restored model, like every other setting here:
      // a cached `true` must not resurrect on a model that has no audio field.
      //
      // `audioDefault` marks a draft written since audio defaulted to ON.
      // Without it, every existing user carries a persisted `false` from before
      // that change and would never see the new default — the setting would
      // look like it had simply been ignored. Older drafts fall through to the
      // initial state, which is the only field this resets.
      if (d.audioDefault && typeof d.generateAudio === "boolean") {
        patch.generateAudio = d.generateAudio && supportsAudio(effModel);
      }
      if (["project", "history", "favorites"].includes(d.rightTab)) {
        patch.rightTab = d.rightTab;
      }
      if (typeof d.rightPanelOpen === "boolean") {
        patch.rightPanelOpen = d.rightPanelOpen;
      }
      // loadProjects validates the restored project id against the fetched
      // list, so a stale id self-heals to the default project.
      if (typeof d.activeProjectId === "string") patch.activeProjectId = d.activeProjectId;
      if (typeof d.activeFolderId === "string") patch.activeFolderId = d.activeFolderId;
      useStore.setState(patch);
    }

    const s = useStore.getState();
    if (s.prompt || s.referenceImages.length) return;
    const prompt = localStorage.getItem(DRAFT_PROMPT_KEY) ?? "";
    const refsRaw = localStorage.getItem(DRAFT_REFS_KEY);
    const refs = refsRaw ? JSON.parse(refsRaw) : [];
    if (!prompt && !(Array.isArray(refs) && refs.length)) return;
    useStore.setState({
      prompt,
      referenceImages: Array.isArray(refs) ? refs.filter((r) => typeof r === "string") : [],
    });
  } catch {
    /* corrupt or unavailable draft — start clean */
  }
}

// ── scope → fetch ───────────────────────────────────────────────────────────
// The right panel's contents are a pure function of (tab, project, folder,
// kind, search), so the fetch belongs to that state rather than to whichever
// component happens to be mounted. Driving it from one subscription means the
// two panels that render feeds cannot disagree about when to refetch, and
// neither has to remember to.
//
// Typing is debounced because search is now a database query: firing one per
// keystroke would issue a request per character and let an early, slower reply
// paint over a later one. (The sequence guard in loadFeed catches that anyway —
// this just stops us making the requests in the first place.)
const SEARCH_DEBOUNCE_MS = 300;

if (typeof window !== "undefined") {
  let scopeTimer: ReturnType<typeof setTimeout> | undefined;
  let lastScopeKey: string | null = null;

  useStore.subscribe((s, prev) => {
    const projectChanged = s.activeProjectId !== prev.activeProjectId;
    const searchChanged = s.search !== prev.search;
    const scopeChanged =
      projectChanged ||
      searchChanged ||
      s.rightTab !== prev.rightTab ||
      s.rightPanelOpen !== prev.rightPanelOpen ||
      s.activeFolderId !== prev.activeFolderId ||
      s.filterKind !== prev.filterKind;
    if (!scopeChanged) return;

    const key = scopeKey(currentScope(s));
    // Switching tabs between two scopes that resolve to the same query (a
    // project with no folder selected vs. the same, say) is not a refetch.
    if (key === lastScopeKey && !projectChanged) return;
    lastScopeKey = key;

    clearTimeout(scopeTimer);
    const run = () => {
      const st = useStore.getState();
      void st.loadFeed();
      void st.loadCounts();
      // The chat thread only depends on the project, so leave it alone when
      // the user is merely filtering the library.
      if (projectChanged) void st.loadThread();
    };
    // Only typing waits; clicking a folder should feel instant.
    if (searchChanged && !projectChanged) scopeTimer = setTimeout(run, SEARCH_DEBOUNCE_MS);
    else run();
  });

  let promptTimer: ReturnType<typeof setTimeout> | undefined;
  useStore.subscribe((s, prev) => {
    if (s.prompt !== prev.prompt) {
      clearTimeout(promptTimer);
      promptTimer = setTimeout(() => {
        try {
          localStorage.setItem(DRAFT_PROMPT_KEY, s.prompt);
        } catch {}
      }, 400);
    }
    if (s.referenceImages !== prev.referenceImages) {
      try {
        localStorage.setItem(DRAFT_REFS_KEY, JSON.stringify(s.referenceImages));
      } catch {
        // Quota exceeded — drop the cached refs but keep the prompt cache.
        try {
          localStorage.removeItem(DRAFT_REFS_KEY);
        } catch {}
      }
    }
    if (
      s.mode !== prev.mode ||
      s.model !== prev.model ||
      s.aspectRatio !== prev.aspectRatio ||
      s.resolution !== prev.resolution ||
      s.duration !== prev.duration ||
      s.batchCount !== prev.batchCount ||
      s.generateAudio !== prev.generateAudio ||
      s.rightTab !== prev.rightTab ||
      s.rightPanelOpen !== prev.rightPanelOpen ||
      s.activeProjectId !== prev.activeProjectId ||
      s.activeFolderId !== prev.activeFolderId
    ) {
      try {
        localStorage.setItem(
          DRAFT_SETTINGS_KEY,
          JSON.stringify({
            mode: s.mode,
            model: s.model,
            aspectRatio: s.aspectRatio,
            resolution: s.resolution,
            duration: s.duration,
            batchCount: s.batchCount,
            generateAudio: s.generateAudio,
            audioDefault: true,
            rightTab: s.rightTab,
            rightPanelOpen: s.rightPanelOpen,
            activeProjectId: s.activeProjectId,
            activeFolderId: s.activeFolderId,
          })
        );
      } catch {}
    }
  });
}
