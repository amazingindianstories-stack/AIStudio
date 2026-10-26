"use client";

import { notify, dismissNotice } from "./notify";

// The last reference-audio limit notice, so a later attempt can withdraw it once the clips change.
let audioProblemNotice = null;


import { create } from "zustand";
import { installOperationTracking } from "./operation-state";
import { snapshotScope, composerMetadata, metadataToDraft, saveComposerSnapshot, loadComposerSnapshot } from "./composer-snapshots";
import { newReferenceId, referenceIdsFor, referencePermutation } from "./reference-order";
import { composerModel, getModelDefinition, isModelAvailable } from "./model-registry";

import {
  DEFAULTS,
  HISTORY_PAGE_SIZE,
  fallbackModel,
  isPickerModel,
  modeAvailable,
  pickerModels,
  aspectRatiosForModel,
  durationsForModel,
  durationRangeForModel,
  resolutionsForModel,
  supportsAudio,
  supportsDraftMode,
  supportsBitrateMode,
  supportsFirstFrameContinuation,
  supportsFirstLastFrame,
  supportsVideoReference,
  supportsVideoEditExtend,
  VIDEO_TASK_MODES,
} from "./config";
import { encodeBlobWithBudget } from "./client-image-budget";
import { inlineMediaUrl } from "./utils";
import { historyFilterToParams } from "./history-query";
import { emptyLibraryFilters, libraryDateBounds, librarySourceKey, normalizeLibraryFilters } from "./library-filters";
import { cleanLibraryQuery, clearLibrarySession, readLibrarySession, writeLibrarySession } from "./library-session";
import { apiFetch as crossOriginFetch, retryWhileBusy, fetchRetryBusy } from "./api";
import { apiErrorMessage } from "./api-error";
import { referenceAudioProblem, withAudioDurations } from "./audio-duration";
import {
  clearFeedCache,
  dedupeFirstPage,
  dropCached,
  dropCachedIn,
  getCached,
  isFeedFresh,
  patchCached,
  putFeedCache,
  staleCached,
  writeCachedItems,
} from "./feed-cache";
import {
  compareInScope,
  matchesScope,
  scopeKey,
  scopeToQuery,
  UNSORTED,
} from "./feed-scope";
import {
  clearStoreTimeout,
  currentStoreRequestSequence,
  disposeStoreRuntime,
  nextStoreRequestSequence,
  setStoreTimeout,
  storeRuntime,
} from "./store-runtime";
import { LIVE_MS_ACTIVE, LIVE_MS_IDLE, liveDelay, liveUpdatesUrl, nextLiveCursor, hasRecentActiveWork } from "./live-cursor";
import { magnificParamsForModel, magnificVideoParamsForModel, MAGNIFIC_VIDEO_DEFAULTS, MAGNIFIC_MODELS, MAGNIFIC_VIDEO_MODELS, MAGNIFIC_SCALE_FACTORS, MAGNIFIC_VIDEO_RESOLUTIONS } from "./magnific-ui";
import {
  clearMaterialCache,
  dedupeMaterialRequest,
  dropMaterialCaches,
  getMaterialCache,
  isMaterialFresh,
  materialKey,
  patchMaterialCaches,
  putMaterialCache,
} from "./material-cache";
import { askText } from "./ask-text";
import { uploadFileDirect } from "./client-reference-upload";
import {
  PORTRAIT_UPLOAD_CONCURRENCY,
  appendPortraitPage,
  createOrderedRegistrar,
  isPortraitPending,
  mergePortraitPage,
  portraitAttachable,
  portraitDimensionProblem,
  portraitFileProblem,
  readPortraitDimensions,
  portraitNameFromFile,
  portraitPollDelay,
  runPool,
  sortPortraits,
} from "./portraits";

const EMPTY_COUNTS = {
  project: { total: 0, unsorted: 0, byFolder: {} },
  globalLibrary: { total: 0, unsorted: 0, byFolder: {} },
  allAssets: 0,
  favorites: 0,
};


// ── scoped feed cache ───────────────────────────────────────────────────────
// Each library view (a project, a folder, Favourites, All assets, each with its
// own kind/search filter) is a separate server query, so flipping between them
// used to mean refetching from scratch. Keeping the last few keyed by scope
// makes that instant, and re-entry revalidates behind the cached copy rather
// than blanking it — the user sees content, then sees it get more correct.
/** Cached pages older than this revalidate on re-entry. Short, because history
 *  is team-wide: a teammate's generation should not stay invisible for long. */
/** Rows loaded for the centre chat thread. Larger than a grid page because the
 *  thread is read top-to-bottom rather than scanned. */
const THREAD_PAGE_SIZE = 60;

// Monotonic request ids. Every async read stamps one and refuses to write if it
// is no longer the newest — the fix for a slow reply for folder A landing after
// a fast reply for folder B and painting the wrong contents.

/** The scope the right panel is currently showing. */
function currentScope(s) {
  let tab = s.rightTab;
  if (tab === "project" && !s.activeProjectId) {
    tab = "library";
  }
  return {
    tab,
    projectId: s.activeProjectId,
    folderId: s.activeFolderId,
    kind: "all",
    q: s.search,
    filters: s.libraryFilters,
    sort: s.librarySort,
    now: s.libraryDateNow,
  };
}

/** Chat follows the open project/folder, independently of grid search and tabs. */
function threadScope(s) {
  return { tab: s.activeProjectId ? "project" : "library", projectId: s.activeProjectId,
    folderId: s.activeFolderId, kind: "all", q: "" };
}

function matchesThread(item, s) {
  return item.kind !== "depth" && item.kind !== "audio" && matchesScope(item, threadScope(s));
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
 *
 * Exported (along with dropEverywhere/findItem/mergeLiveItems) purely for unit testing — see store.test.js.
 * Nothing outside this module is meant to call these directly; every real
 * caller goes through the store's own actions.
 */
export function patchEverywhere(
  set,
  id,
  patch
) {
  patchCached(id, patch);
  set((s) => ({
    items: s.items.map((i) => (i.id === id ? patch(i) : i)),
    threadItems: s.threadItems.map((i) => (i.id === id ? patch(i) : i)),
    pendingItems: s.pendingItems.map((i) => (i.id === id ? patch(i) : i)),
  }));
}

/** Remove a row from every pool, for deletes. */
export function dropEverywhere(
  set,
  id
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

/** Magnific rows are upscales: they reopen in the upscaler with their source, model and parameters. */
export function isMagnificUpscale(item) {
  return MAGNIFIC_MODELS.includes(item?.model) || MAGNIFIC_VIDEO_MODELS.includes(item?.model);
}

function upscaleComposerState(s, item) {
  const name = item.prompt ? item.prompt.slice(0, 50) : "Upscale source";
  if (MAGNIFIC_VIDEO_MODELS.includes(item.model)) {
    const source = item.referenceVideos?.[0];
    return {
      mode: "upscale", upscalerMedia: "video",
      upscalerVideo: source ? { url: source, name, aspectRatio: item.aspectRatio } : null,
      videoUpscalerParams: { ...s.videoUpscalerParams, model: item.model,
        ...(MAGNIFIC_VIDEO_RESOLUTIONS.includes(item.resolution) ? { resolution: item.resolution } : {}), ...(item.upscaleParams ?? {}) },
    };
  }
  const source = item.referenceImages?.[0];
  return {
    mode: "upscale", upscalerMedia: "image",
    upscalerImage: source ? { url: source, name, aspectRatio: item.aspectRatio } : null,
    upscalerParams: { ...s.upscalerParams, model: item.model,
      ...(MAGNIFIC_SCALE_FACTORS.includes(item.resolution) ? { scaleFactor: item.resolution } : {}), ...(item.upscaleParams ?? {}) },
  };
}

const MODEL_AVAILABILITY_KEY = "veevee-model-availability-v1";

/** The server's list of models new jobs may use (registry ids); null for anything else. */
function availabilityIds(value) {
  return Array.isArray(value) && value.every((id) => typeof id === "string") ? value : null;
}

/** The last list this browser received, so a reload starts from it instead of offering a
 *  switched-off model until the session answers. A convenience only: the next answer replaces
 *  it, and enqueue still refuses whatever is off. */
function cachedAvailability() {
  try {
    return availabilityIds(JSON.parse(localStorage.getItem(MODEL_AVAILABILITY_KEY)));
  } catch {
    return null;
  }
}

function cacheAvailability(ids) {
  try {
    localStorage.setItem(MODEL_AVAILABILITY_KEY, JSON.stringify(ids));
  } catch {
    /* storage denied: the next load starts from the full list until the session answers */
  }
}

/** The composer model for reopening a job made with `name`: its own (or a retired model's
 *  replacement) while the `mode` picker offers it, otherwise that picker's fallback with a short
 *  notice saying so. `model` is null when the picker offers nothing. */
export function composerChoice(name, mode, availableIds, media) {
  const model = composerModel(name);
  if (isPickerModel(model, availableIds, mode, media)) return { model, notice: null };
  const label = getModelDefinition(model)?.name ?? model;
  const fallback = fallbackModel(mode, availableIds, media);
  return { model: fallback, notice: fallback ? `${label} isn't available right now. Using ${fallback} instead.` : `${label} isn't available right now.` };
}

/** Reopens a Magnific row in the upscaler, on a fallback upscaler (with a notice) when its own is unavailable. */
function reopenUpscale(get, set, item, extra = {}) {
  const choice = composerChoice(item.model, "upscale", get().availableModelIds, item.kind === "video" ? "video" : "image");
  if (!choice.model) return { ok: false, error: choice.notice };
  set({ ...upscaleComposerState(get(), { ...item, model: choice.model }), ...extra });
  if (!choice.notice) return { ok: true };
  notify(choice.notice, { tone: "info" });
  return { ok: true, notice: choice.notice };
}

/** Moves a reopened job onto the fallback `model`, keeping the job's own aspect ratio, resolution
 *  and duration wherever the fallback offers them; setModel clamps only the rest. */
function applyFallbackModel(get, set, model) {
  const job = get();
  get().setModel(model);
  const s = get();
  const durationRange = durationRangeForModel(model);
  set({
    aspectRatio: aspectRatiosForModel(model, s.mode).includes(job.aspectRatio) ? job.aspectRatio : s.aspectRatio,
    resolution: !s.draftMode && resolutionsForModel(model, s.mode, s.referenceImages.length > 0).includes(job.resolution)
      ? job.resolution : s.resolution,
    duration: (durationRange ? Number.isInteger(job.duration) && job.duration >= durationRange.min && job.duration <= durationRange.max
      : durationsForModel(model).includes(job.duration)) ? job.duration : s.duration,
  });
}

/** Moves every composer choice the pickers no longer offer onto one they do. Applying the same
 *  answer again changes nothing, so arrivals and restores never loop. */
function reconcileAvailability(get, set) {
  const ids = get().availableModelIds;
  if (!modeAvailable(get().mode, ids)) get().setMode(["image", "video"].find((mode) => modeAvailable(mode, ids)) ?? "image");
  const s = get();
  if ((s.mode === "image" || s.mode === "video") && !isPickerModel(s.model, ids, s.mode)) {
    const model = fallbackModel(s.mode, ids);
    if (model) s.setModel(model);
  }
  for (const [media, key] of [["image", "upscalerParams"], ["video", "videoUpscalerParams"]]) {
    const current = get()[key].model;
    const model = isPickerModel(current, ids, "upscale", media) ? current : fallbackModel("upscale", ids, media);
    if (model && model !== current) set((state) => ({ [key]: { ...state[key], model } }));
  }
  const media = get().upscalerMedia === "video" ? "video" : "image";
  const other = media === "video" ? "image" : "video";
  if (!pickerModels(ids, "upscale", media).length && pickerModels(ids, "upscale", other).length) set({ upscalerMedia: other });
}

/** Look a row up across every pool. Callers act on an id the user clicked, and
 *  that row may be in the chat thread but not the current feed (or vice versa),
 *  so searching only `items` would make the action silently do nothing. */
export function findItem(s, id) {
  return (
    s.items.find((i) => i.id === id) ??
    s.threadItems.find((i) => i.id === id) ??
    s.pendingItems.find((i) => i.id === id)
  );
}

/** Put a row back where it sorts (failed delete rollback), not at the head. */
function restoreItemInPlace(set, item) {
  set((s) => {
    const scope = currentScope(s);
    if (!matchesScope(item, scope) || s.items.some((i) => i.id === item.id)) return {};
    const items = [...s.items, item].sort((a, b) => compareInScope(a, b, scope));
    writeCachedItems(scopeKey(scope), items);
    return { items };
  });
}

/** Insert a freshly created row into the pools it belongs in. */
function insertNewItem(
  set,
  item
) {
  set((s) => {
    const scope = currentScope(s);
    const patch = {};

    // A new generation is placed where the active sort puts it: the head for
    // newest first, the tail for oldest first. Under oldest first with more
    // pages to load it belongs on a later page, so it is left for pagination.
    if (matchesScope(item, scope) && !(scope.sort === "oldest" && s.hasMoreHistory && s.items.length && compareInScope(item, s.items.at(-1), scope) > 0)) {
      const items = [item, ...s.items.filter((i) => i.id !== item.id)].sort((a, b) => compareInScope(a, b, scope));
      patch.items = items;
      writeCachedItems(scopeKey(scope), items);
    }
    // The new row may belong to other cached scopes too; make them revalidate.
    staleCached(scopeKey(scope));
    // Depth rows stay project-scoped (the `items` branch above) but never
    // join the conversational thread — they're not a prompt/response chat
    // turn the way image/video generations are, and mixing a worker-run
    // depth job into that feed was explicitly unwanted.
    if (matchesThread(item, s)) {
      patch.threadItems = [item, ...s.threadItems.filter((i) => i.id !== item.id)];
    }
    return patch;
  });
}

// Gallery bookkeeping that is not rendered: request ordering, ids being deleted, and the status poll.
const portraitRuntime = { token: 0, refreshing: false, deleting: new Map(), listSeq: 0, uploadSeq: 0, registrationTail: Promise.resolve(), timer: null, attempt: 0 };

/** Poll only while the gallery is open and something is preparing, waiting or uploading. */
function portraitPollWanted(state) {
  return state.portraitGalleryOpen && state.portraits.enabled === true
    && (state.portraitUploads.some((u) => u.state === "uploading" || u.state === "registering")
      || state.portraits.items.some(isPortraitPending));
}

function schedulePortraitPoll(get) {
  if (portraitRuntime.timer || !portraitPollWanted(get())) return;
  portraitRuntime.timer = setTimeout(() => {
    portraitRuntime.timer = null;
    if (!portraitPollWanted(get())) { portraitRuntime.attempt = 0; return; }
    // A hidden tab skips the request and checks again later.
    if (typeof document !== "undefined" && document.hidden) { schedulePortraitPoll(get); return; }
    portraitRuntime.attempt += 1;
    void get().loadPortraits({ refresh: true });
  }, portraitPollDelay(portraitRuntime.attempt));
}

// One read-only feed observes work performed by Django workers, including jobs
// submitted by another browser or continuing after this browser closes.
async function apiFetch(input, init) {
  const response = await crossOriginFetch(input, init);
  if (response.status === 401) {
    disposeStoreRuntime();
    useStore.setState({ currentUser: null });
    if (typeof window !== "undefined" && window.location.pathname !== "/login") {
      window.location.replace("/login");
    }
    throw new Error("UNAUTHENTICATED");
  }
  return response;
}

// Slow calls (submits, upscales, inline media) can be turned away while the API
// is busy; wait for a slot rather than dropping the user's action.
function apiFetchRetryBusy(input, init = {}) {
  return retryWhileBusy(() => apiFetch(input, init), { signal: init.signal });
}

async function fetchFrameBlob(url) {
  const res = await fetchRetryBusy(inlineMediaUrl(url));
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(apiErrorMessage(body, res.status));
  }
  return res.blob();
}

function submissionId() {
  return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : undefined;
}

/** Upload each distinct inline image once, at most UPLOAD_CONCURRENCY at a time. */
const UPLOAD_CONCURRENCY = 3;
const BULK_DELETE_CONCURRENCY = 4;

export async function uploadInlineReferences(entries, uploadOne, concurrency = UPLOAD_CONCURRENCY) {
  const byValue = new Map();
  const queue = [];
  for (const { value, label } of entries) {
    if (typeof value !== "string" || !value.startsWith("data:") || byValue.has(value)) continue;
    let release;
    byValue.set(value, new Promise((resolve, reject) => { release = { resolve, reject }; }));
    queue.push({ value, label, release });
  }
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const job = queue.shift();
      try { job.release.resolve(await uploadOne(job.value, job.label)); } catch (error) { job.release.reject(error); }
    }
  });
  await Promise.all(workers);
  return Promise.all(entries.map(({ value }) => (byValue.has(value) ? byValue.get(value) : value)));
}

async function uploadDraftBinaryReferences(state) {
  const { uploadOriginalReference } = await import("./client-reference-upload");
  const uploadOne = async (ref, label) => {
    const blob = await (await fetch(ref)).blob();
    return uploadOriginalReference(new File([blob], label, {type:blob.type}));
  };
  const references = state.referenceImages.map((value, i) => ({ value, label: state.referenceLabels?.[i] || "reference" }));
  const frames = [
    { value: state.firstFrame, label: "first-frame" },
    { value: state.lastFrame, label: "last-frame" },
    { value: state.continuationFrame, label: "continuation-frame" },
  ];
  const uploaded = await uploadInlineReferences([...references, ...frames], uploadOne);
  const [firstFrame, lastFrame, continuationFrame] = uploaded.slice(references.length);
  return { referenceImages: uploaded.slice(0, references.length), referenceIds: referenceIdsFor(state),
    firstFrame, lastFrame, continuationFrame };
}

export const CLEAR_SELECTION_PATCH = {
  selectedIds: [],
  focusedAssetId: null,
  selectionAnchorId: null,
};

export const useStore = create((set, get) => ({
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
  draftMode: false,
  bitrateMode: "high",
  videoTaskMode: "generate",
  // Reproducibility seed (Phase 3.1). null for an ordinary "Generate" click —
  // the enqueue route only honours it for models config.supportsSeed
  // confirms, and generate() clears it back to null after a successful
  // submit (see below) so it never silently reattaches to an unrelated
  // follow-up generation. regenerateWithSameSeed is the only action that
  // sets this deliberately.
  seed: null,
  // Multi-shot chaining (Phase 3.3) — "Continue this shot" (continueShot
  // action, below). A single data URL, not part of referenceImages/@imgN:
  // it's not a tagged reference the user chose to include, it's the exact
  // starting frame of THIS generation, submitted with BytePlus's
  continuationFrame: null,
  firstFrame: null,
  lastFrame: null,
  firstFrameMode: false,
  prompt: "",
  referenceImages: [],
  // Reference values the server refused as removed/unready portraits; shown on their cards.
  unavailableReferences: [],
  referenceIds: [],
  referenceReorderUndo: null,
  recentSubmission: null,
  // Parallel to referenceImages, same length/order — "image" | "video",
  // recording whether each entry was a real image upload or a frame
  // extracted from a video file (addImageFiles/addReferenceFromVideo).
  // Display-only: it never leaves the client, never reaches a provider, and
  // the actual @imgN tag/index math in mentions.ts is entirely unaffected —
  // this only decides whether the composer shows a "from video" badge.
  referenceKinds: [],
  referenceTags: [],
  referenceVideos: [],
  referenceAudios: [],
  // Display metadata for uploaded audio references. Each entry is {name, ref}.
  audioNotes: [],
  // Display metadata for attached/uploaded video references. Each entry is {name, ref}.
  videoNotes: [],

  items: [],
  hasMoreHistory: true,
  loading: true,
  refreshing: false,
  feedError: null,
  paginationError: null,
  counts: EMPTY_COUNTS,
  feedKey: "",
  threadItems: [],
  threadScopeKey: null,
  threadLoading: true,
  pendingItems: [],
  feedPinned: true,
  rightPanelOpen: false,
  mobileHistoryOpen: false,
  generating: false,
  // Depth-mode composer only — polled by the status pill (see
  // loadDepthWorkerStatus below). null until the first successful poll, so
  // the pill can show a neutral "checking..." state instead of guessing
  // online/offline before any real answer has come back.
  depthWorkerStatus: null,
  rightTab: "project",
  activeId: null,
  // The surface the viewer was opened from ("feed" grid, "thread" or "single"
  // card) and, for the grid, the scope it showed. Arrow keys walk only that
  // surface's list; see viewer-navigation.js.
  activeSource: "feed",
  activeFeedKey: "",
  // The currently-mounted AssetGrid's packed column layout (arrays of item
  // ids, left to right) — published by AssetGrid whenever it repacks, so
  // DetailModal's Up/Down keys can walk visual neighbors instead of flat
  // list order. See setGridColumns below.
  gridColumns: [],
  search: "",
  libraryFilters: emptyLibraryFilters(),
  librarySort: null,
  libraryGroupByDate: true,
  libraryDateNow: Date.now(),
  selectedIds: [],
  draggedItem: null,
  draggedAssets: [],
  focusedAssetId: null,
  selectionAnchorId: null,

  upscalerImage: null,
  upscalerParams: {
    model: "Magnific Creative",
    scaleFactor: "2x",
    prompt: "",
    optimizedFor: "standard",
    engine: "automatic",
    creativity: 0,
    hdr: 0,
    resemblance: 0,
    fractality: 0,
    flavor: "photo",
    sharpen: 7,
    smartGrain: 7,
    ultraDetail: 30,
    filterNsfw: false,
  },
  upscalerMedia: "image",
  upscalerVideo: null,
  videoUpscalerParams: { ...MAGNIFIC_VIDEO_DEFAULTS },

  assets: [],
  assetsLoading: false,
  assetsRefreshing: false,
  assetsError: null,
  assetsKey: "",
  assetLibraryOpen: false,
  editingAsset: null,

  portraitGalleryOpen: false,
  // The shared Portrait Gallery (VEEVEE_MANAGED_PORTRAITS). enabled === null until the backend answers.
  portraits: { enabled: null, items: [], next: null, loading: false, loadingMore: false, error: null, query: "" },
  // Gallery uploads that have no server row yet (uploading, registering or refused), newest drop first.
  portraitUploads: [],

  currentUser: null,
  // Registry ids of the models new jobs may use (GET /api/auth/me `availability`); null until
  // known, when every offered model shows. See isModelAvailable.
  availableModelIds: null,
  // Whether availableModelIds is the session's answer rather than this browser's cached hint.
  availabilityAnswered: false,
  usersById: {},
  limits: {},

  projects: [],
  globalFolders: [],
  libraryTree: { globalFolders: [], projects: [] },
  activeProjectId: null,
  activeFolderId: null,

  setView: (view) => set({ view }),

  setSeed: (seed) => set({ seed }),
  setFirstFrameMode: (firstFrameMode) =>
    set({
      firstFrameMode,
      ...(firstFrameMode ? {} : { firstFrame: null, continuationFrame: null, lastFrame: null }),
    }),
  setContinuationFrame: (continuationFrame) =>
    set({
      continuationFrame,
      firstFrame: continuationFrame,
      firstFrameMode: Boolean(continuationFrame),
    }),
  setFirstFrame: (firstFrame) =>
    set({
      firstFrame,
      continuationFrame: firstFrame,
      firstFrameMode: Boolean(firstFrame),
    }),
  setLastFrame: (lastFrame) =>
    set({
      lastFrame,
      firstFrameMode: true,
    }),
  clearFrames: () =>
    set({
      firstFrame: null,
      continuationFrame: null,
      lastFrame: null,
      firstFrameMode: false,
    }),
  setReferenceLabel: (index, label) => set((s) => {
    const labels = Array.isArray(s.referenceLabels) ? [...s.referenceLabels] : [];
    labels[index] = String(label ?? "");
    return { referenceLabels: labels };
  }),

  setMode: (mode) => {
    const d = DEFAULTS[mode];
    set({
      mode,
      model: d.model,
      aspectRatio: d.aspectRatio,
      resolution: d.resolution,
      duration: "duration" in d ? d.duration : get().duration,
      videoTaskMode: "generate",
      generateAudio: mode === "video" && supportsAudio(d.model),
      draftMode: supportsDraftMode(d.model) ? get().draftMode : false,
      bitrateMode: supportsBitrateMode(d.model) ? get().bitrateMode : "high",
      ...(mode !== "video" ? { firstFrame: null, lastFrame: null, continuationFrame: null, firstFrameMode: false } : {}),
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
      // Seedance 2.0/2.5 are the one exception: BytePlus takes any integer
      // duration in a bounded range rather than an enum (see
      // durationRangeForModel), so those clamp by min/max instead.
      const durationRange = durationRangeForModel(model);
      let duration;
      if (durationRange) {
        duration = Math.min(durationRange.max, Math.max(durationRange.min, s.duration));
      } else {
        const durations = durationsForModel(model);
        duration = durations.includes(s.duration)
          ? s.duration
          : durations[durations.length - 1];
      }
      const resolutions = resolutionsForModel(model, s.mode, s.referenceImages.length > 0);
      let resolution = (model === "Seedream 5.0 Pro" || model === "seedream-5-pro") && model !== s.model
        ? "2K" : resolutions.includes(s.resolution)
        ? s.resolution
        : resolutions[resolutions.length - 1];
      const aspectRatios = aspectRatiosForModel(model, s.mode);
      // 21:9 is the global image/video default. Preserve a deliberate valid
      // choice while switching between capable models, but restore 21:9 when
      // returning from a constrained provider (Omni only offers 16:9/9:16).
      const previousAspectRatios = aspectRatiosForModel(s.model, s.mode);
      const aspectRatio =
        aspectRatios.includes("21:9") && !previousAspectRatios.includes("21:9")
          ? "21:9"
          : aspectRatios.includes(s.aspectRatio)
            ? s.aspectRatio
            : aspectRatios[0];
      // Same reasoning as the clamps above: a setting the chosen model has no
      // field for must not survive the switch, or the composer shows an
      // enabled toggle whose value the provider will silently discard.
      const generateAudio = supportsAudio(model)
        ? (supportsAudio(s.model) ? s.generateAudio : true)
        : false;
      const draftMode = supportsDraftMode(model) ? s.draftMode : false;
      if (draftMode) resolution = "480p";
      const bitrateMode = supportsBitrateMode(model) ? s.bitrateMode : "high";
      const referenceVideos = supportsVideoReference(model) ? s.referenceVideos : [];
      // Same reasoning: Edit/Extend only exist on Seedance 2.5, so switching
      // away must not leave the composer claiming a mode the new model has
      // no such task type for.
      const videoTaskMode = supportsVideoEditExtend(model) ? s.videoTaskMode : "generate";
      const retainsFrames = supportsFirstLastFrame(model) || supportsFirstFrameContinuation(model);
      const frames = retainsFrames ? {} : { firstFrame: null, lastFrame: null, continuationFrame: null, firstFrameMode: false };
      return { model, duration, resolution, aspectRatio, generateAudio, draftMode, bitrateMode, referenceVideos, videoTaskMode, ...frames };
    }),
  setAspectRatio: (aspectRatio) => set({ aspectRatio }),
  setResolution: (resolution) => set((s) => ({
    resolution: s.draftMode && supportsDraftMode(s.model) ? "480p" : resolution,
  })),
  setDuration: (duration) => set({ duration }),
  setBatchCount: (batchCount) => set({ batchCount: Math.min(4, Math.max(1, batchCount)) }),
  setGenerateAudio: (generateAudio) => set({ generateAudio }),
  setDraftMode: (draftMode) => set(() => ({
    draftMode: draftMode === true,
    ...(draftMode === true ? { resolution: "480p" } : {}),
  })),
  setBitrateMode: (bitrateMode) => set({
    bitrateMode: bitrateMode === "standard" ? "standard" : "high",
  }),
  setVideoTaskMode: (videoTaskMode) => set({
    videoTaskMode: VIDEO_TASK_MODES.includes(videoTaskMode) ? videoTaskMode : "generate",
  }),
  setPrompt: (prompt) => set({ prompt }),
  addReference: (dataUrl, kind = "image", label = "", tag = "") =>
    set((s) => {
      if (s.referenceImages.length + s.referenceVideos.length + s.referenceAudios.length >= 50) return {draftStorageWarning:"Stage at most 50 references. Remove an attachment before adding another."};
      const referenceImages = [...s.referenceImages, dataUrl];
      // Attaching a reference can itself invalidate the chosen resolution:
      // Kling Image 2.1 does 2K in text-to-image but not from a reference
      // (measured — see resolutionsForModel). Clamp here for the same reason
      // the model switch clamps, or the composer keeps showing 2K selected
      // while the picker no longer offers it and the provider refuses it.
      const resolutions = resolutionsForModel(s.model, s.mode, referenceImages.length > 0);
      const referenceLabels = Array.isArray(s.referenceLabels) ? [...s.referenceLabels, label] : [label];
      const referenceTags = Array.isArray(s.referenceTags) ? [...s.referenceTags, tag] : [tag];
      return {
        referenceImages,
        referenceIds: [...referenceIdsFor(s), newReferenceId()],
        referenceReorderUndo: null,
        referenceKinds: [...s.referenceKinds, kind],
        referenceLabels,
        referenceTags,
        resolution: resolutions.includes(s.resolution)
          ? s.resolution
          : resolutions[resolutions.length - 1],
      };
    }),
  // @imgN is positional, as observed in Higgsfield Cinema Studio (removing ref 2,
  // and separately ref 1, left "@Image 1 ... @Image 2 ... @image_3" unchanged:
  // later refs shifted into the freed slots, @image_3 turned red, and attaching
  // a third ref revived it). Neither removing nor reordering rewrites the
  // prompt, so a typed @img1 means whatever occupies slot 1 now, and a tag past
  // the last slot shows red as unresolved until it is replaced or a reference
  // fills that slot again.
  removeReference: (index) =>
    set((s) => ({
      referenceImages: s.referenceImages.filter((_, i) => i !== index),
      referenceIds: referenceIdsFor(s).filter((_, i) => i !== index),
      referenceReorderUndo: null,
      referenceKinds: s.referenceKinds.filter((_, i) => i !== index),
      referenceLabels: (s.referenceLabels || []).filter((_, i) => i !== index),
      referenceTags: (s.referenceTags || []).filter((_, i) => i !== index),
      unavailableReferences: (s.unavailableReferences || []).filter((ref) => ref !== s.referenceImages[index]),
    })),
  reorderReferencesByIds: (ids) => set((s) => ({
    ...referencePermutation(s, ids),
    referenceReorderUndo: { ids: referenceIdsFor(s), afterIds: [...ids] },
  })),
  moveReference: ({ id, toIndex }) => {
    const ids = referenceIdsFor(get());
    const from = ids.indexOf(id);
    if (from < 0 || !Number.isInteger(toIndex) || toIndex < 0 || toIndex >= ids.length || from === toIndex) return;
    ids.splice(from, 1); ids.splice(toIndex, 0, id);
    get().reorderReferencesByIds(ids);
  },
  undoReferenceReorder: () => {
    const s = get(); const undo = s.referenceReorderUndo;
    if (!undo || JSON.stringify(referenceIdsFor(s)) !== JSON.stringify(undo.afterIds)) return;
    set({ ...referencePermutation(s, undo.ids), referenceReorderUndo: null });
  },
  // Compatibility for old callers: match occurrences once, never indexOf equality.
  reorderReferences: (newOrder) => {
    const s = get(); const ids = referenceIdsFor(s); const used = new Set();
    const order = newOrder.map(ref => {
      const index = s.referenceImages.findIndex((value, i) => value === ref && !used.has(i));
      if (index < 0) throw new Error("Unknown reference occurrence");
      used.add(index); return ids[index];
    });
    set({ referenceIds: ids }); get().reorderReferencesByIds(order);
  },
  clearComposerDraft: () => set({ prompt: "", referenceImages: [], referenceIds: [], referenceKinds: [], referenceLabels: [], referenceTags: [], referenceVideos: [], referenceAudios: [], videoNotes: [], audioNotes: [], referenceReorderUndo: null }),
  restoreRecentSubmission: () => {
    const recent = get().recentSubmission;
    if (recent) set(structuredClone(recent));
  },
  addReferenceVideo: (ref, note) =>
    set((s) => {
      const maxAllowed = 50 - s.referenceImages.length - s.referenceAudios.length;
      if (s.referenceVideos.includes(ref) || s.referenceVideos.length >= maxAllowed) {
        return {};
      }
      const noteEntry =
        typeof note === "string"
          ? { name: note, ref }
          : note || { name: `Clip ${s.referenceVideos.length + 1}`, ref };
      return {
        referenceVideos: [...s.referenceVideos, ref],
        videoNotes: [...(s.videoNotes || []), noteEntry],
      };
    }),
  removeReferenceVideo: (index) =>
    set((s) => ({
      referenceVideos: s.referenceVideos.filter((_, i) => i !== index),
      videoNotes: (s.videoNotes || []).filter((_, i) => i !== index),
    })),

  // See audioNotes' comment above — filename only, no real attachment.
  addAudioNote: (audio) => set((s) => s.referenceImages.length + s.referenceVideos.length + s.referenceAudios.length >= 50 ? {draftStorageWarning:"Stage at most 50 references."} : ({ audioNotes: [...s.audioNotes, audio], referenceAudios: audio?.ref ? [...s.referenceAudios, audio.ref] : s.referenceAudios })),
  removeAudioNote: (index) =>
    set((s) => ({ audioNotes: s.audioNotes.filter((_, i) => i !== index), referenceAudios: s.referenceAudios.filter((_, i) => i !== index) })),

  setRightTab: (rightTab) =>
    set((s) => ({
      rightTab,
      ...(s.rightTab !== rightTab ? CLEAR_SELECTION_PATCH : {}),
    })),
  setActiveId: (activeId, source = "feed") =>
    set((s) => ({
      activeId,
      activeSource: activeId ? source : "feed",
      activeFeedKey: activeId ? s.feedKey : "",
    })),
  // `columns` is AssetGrid's packColumns() output (arrays of items). Stored
  // as id arrays only — DetailModal doesn't need the items themselves, and
  // this avoids holding a second reference to objects that already live in
  // `items`/the feed cache.
  setGridColumns: (columns) =>
    set({ gridColumns: columns.map((col) => col.map((item) => item.id)) }),
  setSearch: (search) =>
    set((s) => (s.search === search ? {} : { search, ...CLEAR_SELECTION_PATCH })),
  setLibraryFilters: (value) => {
    const filters = normalizeLibraryFilters(value);
    if (libraryDateBounds(filters) === null) return;
    set({ libraryFilters: filters, ...CLEAR_SELECTION_PATCH });
  },
  setLibrarySort: (librarySort) => set({ librarySort, ...CLEAR_SELECTION_PATCH }),
  setLibraryGroupByDate: (libraryGroupByDate) => set({ libraryGroupByDate }),
  setLibraryDateNow: (libraryDateNow) => set({ libraryDateNow }),
  setDraggedItem: (draggedItem) => set({ draggedItem }),
  setDraggedAssets: ({ items = [], _ids = [], primaryItem = null } = {}) =>
    set({
      draggedAssets: items,
      draggedItem: primaryItem || (items && items[0]) || null,
    }),
  clearDraggedAssets: () => set({ draggedAssets: [], draggedItem: null }),
  setFocusedAssetId: (focusedAssetId) => set({ focusedAssetId }),
  setSelectionAnchorId: (selectionAnchorId) => set({ selectionAnchorId }),
  setSelectedIds: (selectedIds) => set({ selectedIds }),
  setUpscalerImage: (upscalerImage) => set({ upscalerImage }),
  setUpscalerMedia: (upscalerMedia) => set({ upscalerMedia: upscalerMedia === "video" ? "video" : "image" }),
  setUpscalerVideo: (upscalerVideo) => set({ upscalerVideo }),
  setVideoUpscalerParam: (key, value) =>
    set((s) => ({ videoUpscalerParams: { ...s.videoUpscalerParams, [key]: value } })),
  setUpscalerParam: (key, value) =>
    set((s) => ({ upscalerParams: { ...s.upscalerParams, [key]: value } })),

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
    // Revalidating the scope already on screen keeps the pages loaded beyond
    // page 1 (and their scroll position) instead of collapsing to page 1.
    const onScreen = key === get().feedKey ? get().items : null;

    // Serve the cache first. Re-entering a scope is the common case (clicking
    // between folders, flipping tabs), and re-rendering identical rows behind a
    // skeleton is both slower to read and a layout jump for no information.
    const isNewFeedScope = key !== get().feedKey;
    if (cached && !force) {
      set({
        items: cached.items,
        hasMoreHistory: cached.nextCursor !== null,
        loading: false,
        pendingItems: [],
        feedKey: key,
        ...(isNewFeedScope ? CLEAR_SELECTION_PATCH : {}),
      });
      if (isFeedFresh(cached)) return;
    }

    const hasSomethingToShow = Boolean(cached);
    set(
      hasSomethingToShow
        ? { refreshing: true, feedError: null, feedKey: key, ...(isNewFeedScope ? CLEAR_SELECTION_PATCH : {}) }
        : { loading: true, refreshing: false, feedError: null, items: [], pendingItems: [], feedKey: key, ...CLEAR_SELECTION_PATCH }
    );

    // Every in-flight feed request carries a sequence number; only the newest
    // may write. Without this, clicking through folders faster than the network
    // answers lets an earlier reply land last and paint the wrong folder's
    // contents under the right folder's highlight.
    const seq = nextStoreRequestSequence("feed");
    try {
      const params = historyFilterToParams(scopeToQuery(scope));
      params.set("limit", String(HISTORY_PAGE_SIZE));
      const json = await dedupeFirstPage(key, async () => {
        const res = await apiFetch(`/api/history?${params}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`History request failed (${res.status})`);
        return res.json();
      });
      if (seq !== currentStoreRequestSequence("feed")) return; // superseded

      let items = json.items ?? [];
      let nextCursor = json.nextCursor ?? null;
      const loadedTail = onScreen && nextCursor !== null && items.length
        ? onScreen.filter((row) => !items.some((fresh) => fresh.id === row.id)
            && compareInScope(items[items.length - 1], row, scope) < 0)
        : [];
      if (loadedTail.length) {
        items = [...items, ...loadedTail];
        nextCursor = cached?.nextCursor ?? nextCursor;
      }
      putFeedCache(key, { items, nextCursor, at: Date.now(), scope });
      set({
        items,
        hasMoreHistory: nextCursor !== null,
        loading: false,
        refreshing: false,
        feedError: null,
        paginationError: null,
        pendingItems: [],
        feedKey: key,
      });
      // Resume driving anything still in flight that this page revealed.
    } catch (error) {
      if (seq !== currentStoreRequestSequence("feed")) return;
      set({ loading: false, refreshing: false, feedError: error?.message || "Could not load assets." });
    }
  },

  loadMoreHistory: async () => {
    const s = get();
    if (!s.hasMoreHistory) return;
    const key = scopeKey(currentScope(s));
    const cursor = getCached(key)?.nextCursor;
    if (!cursor) return;
    // The grid's scroller and the viewer's arrow keys can ask for the same next
    // page at once; they share one request.
    await dedupeFirstPage(`more:${key}:${cursor}`, () => get().fetchMoreHistory());
  },

  fetchMoreHistory: async () => {
    const s = get();
    if (!s.hasMoreHistory) return;
    const scope = currentScope(s);
    const key = scopeKey(scope);
    const cached = getCached(key);
    const cursor = cached?.nextCursor;
    if (!cursor) return;

    const seq = currentStoreRequestSequence("feed"); // appends belong to the scope that is current now
    set({ paginationError: null });
    try {
      const params = historyFilterToParams(scopeToQuery(scope));
      params.set("limit", String(HISTORY_PAGE_SIZE));
      params.set("cursor", cursor);
      const res = await apiFetch(`/api/history?${params}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`History request failed (${res.status})`);
      const json = await res.json();
      if (seq !== currentStoreRequestSequence("feed")) return; // scope changed while we were paging

      const newItems = json.items ?? [];
      const nextCursor = json.nextCursor ?? null;

      set((st) => {
        // Dedupe by id. A row can legitimately appear in two pages if it was
        // favourited (Favourites is ordered by favoritedAt, which moves) or
        // moved between projects mid-scroll; React would then throw on the
        // duplicate key.
        const seen = new Set(st.items.map((i) => i.id));
        const appended = [...st.items, ...newItems.filter((i) => !seen.has(i.id))];
        putFeedCache(key, { items: appended, nextCursor, at: Date.now(), scope });
        return { items: appended, hasMoreHistory: nextCursor !== null };
      });
    } catch (e) {
      if (seq === currentStoreRequestSequence("feed")) {
        set({ paginationError: e?.message || "Could not load more assets." });
      }
      console.error("Failed to load more history:", e);
    }
  },

  loadCounts: async () => {
    const scope = currentScope(get());
    const seq = nextStoreRequestSequence("counts");
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
      if (seq !== currentStoreRequestSequence("counts")) return;
      set({
        counts: {
          project: json.project ?? EMPTY_COUNTS.project,
          globalLibrary: json.globalLibrary ?? EMPTY_COUNTS.globalLibrary,
          allAssets: Number(json.allAssets ?? 0),
          favorites: Number(json.favorites ?? 0),
        },
      });
    } catch {
      /* counts are decoration — a failure leaves the last known numbers */
    }
  },

  loadThread: async () => {
    const scope = threadScope(get());
    const key = scopeKey(scope);
    const seq = nextStoreRequestSequence("thread");
    if (get().threadScopeKey !== key) set({ threadItems: [], threadScopeKey: key, threadLoading: true });
    try {
      const params = historyFilterToParams(scopeToQuery(scope));
      params.set("limit", String(THREAD_PAGE_SIZE));
      const res = await apiFetch(`/api/history?${params}`, { cache: "no-store" });
      const json = await res.json();
      if (seq !== currentStoreRequestSequence("thread") || key !== scopeKey(threadScope(get()))) return;
      // Depth rows are excluded from the thread (see insertNewItem's comment) —
      // filtered client-side rather than via the shared history-query `kind`
      // param, which only supports a single "image"|"video" inclusion filter
      // used across the feed/admin logs/etc; adding exclusion there for this
      // one low-volume kind isn't worth the shared-surface risk. This can
      // undershoot THREAD_PAGE_SIZE when a page happens to contain depth
      // rows — acceptable for a kind this infrequent, on an unpaginated
      // single fetch.
      const threadItems = (json.items ?? []).filter((it) => matchesThread(it, get()));
      set({ threadItems, threadLoading: false });
    } catch {
      if (seq !== currentStoreRequestSequence("thread")) return;
      set({ threadLoading: false });
    }
  },

  flushPendingItems: () => {
    set((s) => {
      if (!s.pendingItems.length) return {};
      const scope = currentScope(s);
      const byId = new Map(s.items.map((i) => [i.id, i]));
      for (const inc of s.pendingItems) byId.set(inc.id, inc);
      const items = Array.from(byId.values()).filter(item => matchesScope(item, scope)).sort((a, b) =>
        compareInScope(a, b, scope)
      );
      writeCachedItems(scopeKey(scope), items);
      return { items, pendingItems: [] };
    });
  },

  setRightPanelOpen: (rightPanelOpen) => set({ rightPanelOpen }),
  setMobileHistoryOpen: (mobileHistoryOpen) => set({ mobileHistoryOpen }),

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
    if (storeRuntime.liveRunning) return; // idempotent — strict mode mounts effects twice
    storeRuntime.liveRunning = true;
    // Start the watermark slightly in the past so a job that finished during
    // the initial page load isn't missed in the gap before the first poll.
    storeRuntime.liveSince = Date.now() - 60_000;
    storeRuntime.liveAfterId = null;
    storeRuntime.liveFailures = 0;
    if (typeof document !== "undefined" && !storeRuntime.liveVisibilityHandler) {
      // Returning to a backgrounded tab is exactly when the view is most
      // stale, so catch up immediately rather than waiting out the interval.
      storeRuntime.liveVisibilityHandler = () => {
        if (!document.hidden && storeRuntime.liveRunning) {
          scheduleLive(set, get, 0);
        }
      };
      document.addEventListener("visibilitychange", storeRuntime.liveVisibilityHandler);
    }
    scheduleLive(set, get, LIVE_MS_ACTIVE);
  },

  stopLiveUpdates: () => {
    storeRuntime.liveRunning = false;
    if (storeRuntime.liveTimer) {
      storeRuntime.liveTimer = clearStoreTimeout(storeRuntime.liveTimer);
    }
    if (typeof document !== "undefined" && storeRuntime.liveVisibilityHandler) {
      document.removeEventListener("visibilitychange", storeRuntime.liveVisibilityHandler);
      storeRuntime.liveVisibilityHandler = null;
    }
  },

  generate: async () => {
    let s = get();
    const prompt = s.prompt.trim();
    if (!prompt || s.generating) return [];
    if (s.referenceImages.some(ref => !ref)) {
      notify("Attach the missing draft references again before generating.");
      return [];
    }
    if (s.mode === "video" && s.firstFrameMode && !s.firstFrame && !s.continuationFrame) {
      notify("Please select a first frame or toggle First Frame off.");
      return [];
    }
    if ((s.unavailableReferences || []).some((ref) => s.referenceImages.includes(ref))) {
      notify("Remove the reference marked Unavailable before generating.");
      return [];
    }

    set({ generating: true });
    // A notice about an earlier attempt's clips is stale once the artist changed them; recheck below.
    if (audioProblemNotice !== null) { dismissNotice(audioProblemNotice); audioProblemNotice = null; }
    if (s.mode === "video" && s.audioNotes?.length) {
      // The provider refuses clips outside its length limits after queueing;
      // stop here instead, naming the clip, so the artist trims it first.
      const audioNotes = await withAudioDurations(s.audioNotes);
      if (audioNotes !== s.audioNotes) {
        set((state) => (state.audioNotes === s.audioNotes ? { audioNotes } : {}));
        s = { ...s, audioNotes };
      }
      const audioProblem = referenceAudioProblem(s.model, audioNotes, prompt);
      if (audioProblem) {
        set({ generating: false });
        audioProblemNotice = notify(audioProblem.message);
        return [];
      }
    }
    try {
      const uploaded = await uploadDraftBinaryReferences(s);
      const current = get();
      if (current.currentUser?.id !== s.currentUser?.id || current.activeProjectId !== s.activeProjectId) {
        set({ generating: false });
        notify("The user or project changed during upload. Review the draft before submitting.");
        return [];
      }
      if (current.referenceImages === s.referenceImages) set(uploaded);
      s = { ...s, ...uploaded };
    } catch (error) {
      set({ generating: false });
      notify(error.message || "Could not upload draft references.");
      return [];
    }
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
      referenceAudios: s.referenceAudios,
      generateAudio: s.generateAudio,
      draftMode: s.draftMode,
      bitrateMode: s.bitrateMode,
      videoTaskMode,
      // Only ever non-null when regenerateWithSameSeed set it deliberately —
      // the enqueue route re-checks config.supportsSeed itself and drops it
      // silently for a model that doesn't support it, same convention as
      // generateAudio above.
      seed: s.seed ?? undefined,
      // Multi-shot chaining (Phase 3.3) — only ever non-null when
      // continueShot set it deliberately. The enqueue route re-checks
      // config.supportsFirstFrameContinuation itself and drops it silently
      // for a model that doesn't support it, same convention as seed/
      // generateAudio above.
      continuationFrame: s.firstFrame ?? s.continuationFrame ?? undefined,
      firstFrame: s.firstFrame ?? s.continuationFrame ?? undefined,
      lastFrame: s.lastFrame ?? undefined,
      projectId: s.activeProjectId ?? undefined,
      folderId: (s.activeFolderId && s.activeFolderId !== UNSORTED) ? s.activeFolderId : undefined,
    };

    const created = [];
    // Batch: enqueue N independent jobs with the same payload. The queue's
    // per-kind concurrency cap decides how many actually run at once.
    const count = Math.min(4, Math.max(1, s.batchCount || 1));
    // One key per batch slot: a re-sent POST returns the same generation
    // instead of queueing a second paid job.
    const submissionKey = submissionId();
    try {
      for (let i = 0; i < count; i++) {
        const res = await apiFetchRetryBusy(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(submissionKey ? { "Idempotency-Key": `${submissionKey}-${i}` } : {}) },
          body: JSON.stringify(payload),
        });
        let item;
        try {
          item = await res.json();
        } catch {
          throw new Error(`Server error (${res.status}): the server returned an empty or invalid response.`);
        }
        if (!res.ok) {
          const unavailable = item?.code === "PORTRAIT_UNAVAILABLE" && Number.isInteger(item.referenceIndex)
            ? s.referenceImages?.[item.referenceIndex - 1] : null;
          if (typeof unavailable === "string") {
            set((state) => ({ unavailableReferences: [...new Set([...(state.unavailableReferences || []), unavailable])] }));
          }
          throw new Error(apiErrorMessage(item, res.status));
        }
        if (item?.id) {
          // Stay on the tab the user chose. Forcing "history" (All assets) on
          // every submit yanked them out of the project they were working in,
          // which is also the scope the new item was generated into.
          insertNewItem(set, item);
          // Clear seed/continuationFrame/firstFrame/lastFrame here, not just prompt:
          // these are one-shot flags, not standing composer preferences.
          set({ recentSubmission: structuredClone({ prompt: s.prompt, referenceImages: s.referenceImages,
            referenceIds: referenceIdsFor(s), referenceKinds: s.referenceKinds, referenceLabels: s.referenceLabels,
            referenceTags: s.referenceTags, referenceVideos: s.referenceVideos, referenceAudios: s.referenceAudios,
            videoNotes: s.videoNotes, audioNotes: s.audioNotes }), referenceReorderUndo: null,
            seed: null, continuationFrame: null, firstFrame: null, lastFrame: null, firstFrameMode: false });
          // The server coordinator owns execution. The live feed/history
          // resync is the only client-side recovery path.
          created.push(item);
        }
      }
    } catch (e) {
      console.error("Generation request failed:", e);
      // The batch loop above is sequential (awaited one at a time), so a
      // failure on request K of N leaves 1..K-1 already submitted, already
      // in the feed, and tracked by the worker. Reporting only "failed" here reads
      // as "nothing happened" and invites a re-click that doubles up the
      // jobs that already went through — say how many actually started.
      const message = e.message || "Failed to start generation.";
      notify(
        created.length > 0
          ? `${created.length} of ${count} generations started. The rest failed: ${message}`
          : message
      );
    } finally {
      // Moved out of the try block's tail so partial batches still get an
      // accurate folder-rail count instead of waiting for some unrelated
      // reload to correct it.
      void get().loadCounts();
      set({ generating: false });
    }
    return created;
  },

  /**
   * Depth mode's own submit path — not folded into generate() above because
   * the payload shape barely overlaps (a storage key instead of a prompt, no
   * aspect ratio/resolution/reference-image machinery, no batch loop: a
   * depth job runs on one local worker, so submitting four at once would
   * just queue three of them behind the first with nothing to show for it
   * yet). `inputVideoKey` must already be uploaded — see DepthComposer.jsx's
   * use of /api/uploads/presign.
   */
  generateDepthMap: async ({ inputVideoKey, encoder, trackCharacters, originalName }) => {
    if (get().generating) return null;
    set({ generating: true });
    try {
      const res = await apiFetch("/api/generate/depth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inputVideoKey,
          encoder,
          trackCharacters,
          originalName,
          projectId: get().activeProjectId ?? undefined,
          folderId: (get().activeFolderId && get().activeFolderId !== UNSORTED) ? get().activeFolderId : undefined,
        }),
      });
      let item;
      try {
        item = await res.json();
      } catch {
        throw new Error(`Server error (${res.status}): the server returned an empty or invalid response.`);
      }
      if (!res.ok) throw new Error(apiErrorMessage(item, res.status));
      if (item?.id) {
        insertNewItem(set, item);
      }
      return item;
    } catch (e) {
      console.error("Depth-map request failed:", e);
      notify(e.message || "Failed to start depth-map generation.");
      return null;
    } finally {
      void get().loadCounts();
      set({ generating: false });
    }
  },

  /**
   * Magnific AI Upscaler submit path.
   * Sends the source image, model variant, and model parameters to /api/generate/upscale.
   */
  generateUpscale: async () => {
    const s = get();
    if (!s.upscalerImage) {
      notify("Please select or drop an image to upscale.");
      return null;
    }
    if (s.generating) return null;
    set({ generating: true });

    try {
      const rawImage =
        typeof s.upscalerImage === "string"
          ? s.upscalerImage
          : s.upscalerImage.url || s.upscalerImage.data;

      const res = await apiFetchRetryBusy("/api/generate/upscale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: rawImage,
          model: s.upscalerParams.model,
          params: magnificParamsForModel(s.upscalerParams.model, s.upscalerParams),
          projectId: s.activeProjectId ?? undefined,
          folderId: (s.activeFolderId && s.activeFolderId !== UNSORTED) ? s.activeFolderId : undefined,
        }),
      });

      let item;
      try {
        item = await res.json();
      } catch {
        throw new Error(`Server error (${res.status}): invalid response.`);
      }
      if (!res.ok) throw new Error(apiErrorMessage(item, res.status));

      if (item?.id) {
        insertNewItem(set, item);
        if (get().upscalerImage === s.upscalerImage) set({ upscalerImage: null });
      }
      return item;
    } catch (e) {
      console.error("Upscale request failed:", e);
      notify(e.message || "Failed to start upscale.");
      return null;
    } finally {
      void get().loadCounts();
      set({ generating: false });
    }
  },

  /** Magnific video upscale: the source is an uploaded or library video. */
  generateVideoUpscale: async () => {
    const s = get();
    if (!s.upscalerVideo) {
      notify("Please select or drop a video to upscale.");
      return null;
    }
    if (s.generating) return null;
    set({ generating: true });
    try {
      const model = s.videoUpscalerParams.model;
      const res = await apiFetchRetryBusy("/api/generate/upscale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          video: s.upscalerVideo.url,
          model,
          params: magnificVideoParamsForModel(model, s.videoUpscalerParams),
          projectId: s.activeProjectId ?? undefined,
          folderId: (s.activeFolderId && s.activeFolderId !== UNSORTED) ? s.activeFolderId : undefined,
        }),
      });
      let item;
      try {
        item = await res.json();
      } catch {
        throw new Error(`Server error (${res.status}): invalid response.`);
      }
      if (!res.ok) throw new Error(apiErrorMessage(item, res.status));
      if (item?.id) {
        insertNewItem(set, item);
        if (get().upscalerVideo === s.upscalerVideo) set({ upscalerVideo: null });
      }
      return item;
    } catch (e) {
      console.error("Video upscale request failed:", e);
      notify(e.message || "Failed to start the video upscale.");
      return null;
    } finally {
      void get().loadCounts();
      set({ generating: false });
    }
  },

  /** Regenerate a Magnific row with its own source, model and validated parameters. */
  resubmitUpscale: async (item) => {
    const video = item.kind === "video";
    const source = video ? item.referenceVideos?.[0] : item.referenceImages?.[0];
    if (!source || !item.upscaleParams) return { ok: false, error: "The original upscale settings are no longer available." };
    set({ generating: true });
    try {
      const res = await apiFetchRetryBusy("/api/generate/upscale", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [video ? "video" : "image"]: source, model: item.model, params: item.upscaleParams,
          projectId: item.projectId ?? undefined, folderId: item.folderId ?? undefined }),
      });
      let created;
      try {
        created = await res.json();
      } catch {
        throw new Error(`Server error (${res.status}): invalid response.`);
      }
      if (!res.ok) throw new Error(apiErrorMessage(created, res.status));
      if (created?.id) insertNewItem(set, created);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || "The upscale could not be started again." };
    } finally {
      void get().loadCounts();
      set({ generating: false });
    }
  },

  /** Polled by DepthComposer / the nav status pill — see depth-jobs-db.js's
   *  readDepthWorkerStatus for the response shape. Failures leave the last
   *  known status in place rather than flashing the pill to a wrong state on
   *  one dropped request. */
  loadDepthWorkerStatus: async () => {
    try {
      const res = await apiFetch("/api/worker/depth/status", { cache: "no-store" });
      const json = await res.json();
      set({ depthWorkerStatus: json });
    } catch {
      /* keep the last known status */
    }
  },

  deleteGenerations: async (ids) => {
    const results = [];
    await runPool(ids, BULK_DELETE_CONCURRENCY, async (id, index) => {
      results[index] = await get().removeItem(id, { refresh: false });
    });
    const failed = results.find((result) => !result.ok);
    await Promise.all([get().loadCounts(), failed && get().loadFeed({ force: true })]);
    if (failed) throw new Error(failed.error);
    return true;
  },

  cancelGeneration: async (id) => {
    try {
      const res = await apiFetch("/api/generate/cancel", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }),
      });
      const body = await res.json().catch(() => ({}));
      if (body.item?.id) patchEverywhere(set, id, (item) => ({ ...item, ...body.item }));
      void get().loadFeed({ force: true });
      if (res.ok) return { ok: true };
      return { ok: false, error: body.message || body.error || "Cancellation could not be confirmed. The generation will continue to be checked." };
    } catch (error) {
      return { ok: false, error: error.message || "Cancellation could not be confirmed. Try again." };
    }
  },

  removeItem: async (id, { refresh = true } = {}) => {
    // Captured before the optimistic drop below, so a failed delete has
    // something to restore — dropEverywhere removes the row from every pool
    // it might be in, not just `items`.
    const item = findItem(get(), id);

    dropEverywhere(set, id);
    set((s) => ({ activeId: s.activeId === id ? null : s.activeId }));
    if (refresh) void get().loadCounts();
    try {
      const res = await apiFetch(`/api/history?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          res.status === 403
            ? "You don't have permission to delete this."
            : body.error === "GENERATION_REQUIRES_RECONCILIATION"
              ? "This generation is still rendering. Wait for it to finish, then delete it."
              : apiErrorMessage(body, res.status)
        );
      }
      set((s) => ({
        selectedIds: s.selectedIds.filter((selected) => selected !== id),
        focusedAssetId: s.focusedAssetId === id ? null : s.focusedAssetId,
        selectionAnchorId: s.selectionAnchorId === id ? null : s.selectionAnchorId,
      }));
      return { ok: true };
    } catch (e) {
      // The optimistic removal above has to come back — this used to be a
      // silent no-op on failure, which meant a rejected delete (permission
      // denied, a network blip, the row already gone) left the item
      // invisible in this tab even though it was untouched server-side,
      // with zero indication anything went wrong. Mirrors toggleFavorite's
      // rollback below. restoreItemInPlace puts the row back where it sorts;
      // loadFeed corrects scope membership right after.
      if (item) restoreItemInPlace(set, item);
      if (refresh) {
        void get().loadFeed({ force: true });
        void get().loadCounts();
      }
      return { ok: false, error: e.message || "Failed to delete." };
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
    staleCached();
    // Un-starring while looking at Favourites is a membership change, not just
    // a field change: the row no longer belongs in this scope.
    if (!nextFavorite && (get().rightTab === "favorites" || get().libraryFilters.favorite)) {
      // Only Favourites scopes lose the row; project/library caches keep it.
      dropCachedIn(id, (key) => key.startsWith("favorites:"));
      set((s) => ({ items: s.items.filter((i) => i.id !== id) }));
    }
    void get().loadCounts();

    try {
      const res = await apiFetch("/api/history", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, isFavorite: nextFavorite }),
      });
      if (!res.ok) throw new Error("Favourite update failed.");
      const updated = await res.json();
      if (updated?.id) patchEverywhere(set, updated.id, (i) => ({ ...i, ...updated }));
    } catch {
      patchEverywhere(set, id, (i) => ({
        ...i,
        isFavorite: item.isFavorite,
        favoritedAt: item.favoritedAt,
      }));
      staleCached();
      // The optimistic removal above has to come back too.
      if (!nextFavorite && (get().rightTab === "favorites" || get().libraryFilters.favorite)) void get().loadFeed({ force: true });
      void get().loadCounts();
    }
  },

  // Lightweight quality feedback signal (Phase 3.5) — independent of
  // toggleFavorite above (see schema.js's `flagged` comment for why these
  // are two separate booleans). Unflagging never asks for a reason; flagging
  // does, via the in-app text dialog (askText). An empty or
  // cancelled prompt still flags the row (a null reason is a valid flag,
  // just an unexplained one) — only an explicit Cancel-with-no-flag case
  // doesn't happen here because the flag itself isn't gated on the prompt.
  toggleFlag: async (id) => {
    const item = findItem(get(), id);
    if (!item) return;

    const nextFlagged = !item.flagged;
    const reason = nextFlagged
      ? (await askText({ title: "Flag this generation", label: "What's wrong with it? (optional)", confirmLabel: "Flag", optional: true, maxLength: 500 })) || null
      : null;
    const flaggedAt = nextFlagged ? Date.now() : undefined;
    patchEverywhere(set, id, (i) => ({
      ...i,
      flagged: nextFlagged,
      flaggedAt,
      flagReason: reason,
    }));

    try {
      const res = await apiFetch("/api/history", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, flagged: nextFlagged, flagReason: reason }),
      });
      if (!res.ok) throw new Error("Flag update failed.");
      const updated = await res.json();
      if (updated?.id) patchEverywhere(set, updated.id, (i) => ({ ...i, ...updated }));
    } catch {
      patchEverywhere(set, id, (i) => ({
        ...i,
        flagged: item.flagged,
        flaggedAt: item.flaggedAt,
        flagReason: item.flagReason,
      }));
      notify("Failed to update flag — please try again.");
    }
  },

  retryTextToVideo: async (id) => {
    const item = findItem(get(), id);
    if (!item) return { ok: false, error: "This generation is no longer available." };
    if (get().generating) return { ok: false, error: "Another generation is already starting." };
    // Drop @tags so leftover references don't confuse a no-image generation.
    const cleanPrompt = item.prompt
      .replace(/@[\w-]+/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (!cleanPrompt) return { ok: false, error: "No prompt remains after removing references." };

    set({ generating: true });
    const submissionKey = submissionId();
    try {
      const res = await apiFetchRetryBusy("/api/generate/video", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(submissionKey ? { "Idempotency-Key": submissionKey } : {}) },
        body: JSON.stringify({
          prompt: cleanPrompt,
          model: item.model,
          aspectRatio: item.aspectRatio,
          resolution: item.resolution,
          duration: item.duration,
          referenceImages: [],
          draftMode: item.draftMode,
          bitrateMode: item.bitrateMode,
          projectId: item.projectId,
          folderId: item.folderId,
        }),
      });
      const newItem = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiErrorMessage(newItem, res.status));
      if (newItem?.id) {
        insertNewItem(set, newItem);
        if (
          newItem.kind === "video" &&
          (newItem.status === "running" || newItem.status === "queued")
        ) {
        }
        return { ok: true };
      }
      throw new Error("The retry did not create a generation.");
    } catch (e) {
      return { ok: false, error: e.message || "The retry could not be started." };
    } finally {
      set({ generating: false });
    }
  },

  editInComposer: (id) => {
    const item = findItem(get(), id);
    if (!item) return { ok: false, error: "This generation is no longer available." };
    if (isMagnificUpscale(item)) return reopenUpscale(get, set, item);
    set({ mode: item.kind, prompt: item.prompt });
    return { ok: true };
  },

  addReferenceFromUrl: async (url) => {
    // Durable stored references are resolved and authorized by Django.
    get().addReference(url);
  },

  regenerate: async (id) => {
    // Reuses cloneToComposer rather than rebuilding the payload: it already
    // restores model/ratio/resolution/duration/audio AND re-fetches the stored
    // reference images as data URLs, which a fresh submit needs. Then just
    // submit what it loaded.
    if (get().generating) return { ok: false, error: "Another generation is already starting." };
    const original = findItem(get(), id);
    if (isMagnificUpscale(original)) {
      if (isModelAvailable(original.model, get().availableModelIds)) return get().resubmitUpscale(original);
      return get().cloneToComposer(id);
    }
    const cloned = await get().cloneToComposer(id);
    if (cloned?.ok === false) return cloned;
    // A fallback model makes a different job: leave it in the composer, with its notice, unsent.
    if (cloned?.notice) return { ok: true };
    if (!get().prompt.trim()) return { ok: false, error: "The saved prompt is empty." };
    await get().generate();
    return { ok: true };
  },

  /** Same as regenerate, but pins the composer's seed to the ORIGINAL item's
   *  seed before submitting — a deliberately different result from
   *  regenerate() above, which produces a fresh (usually different) render.
   *  Only meaningful for a model config.supportsSeed confirms and only when
   *  the item actually carries one (older rows predate Phase 3.1 and are
   *  null); callers should gate the UI entry point on `item.seed != null`
   *  rather than relying on this to silently no-op. */
  regenerateWithSameSeed: async (id) => {
    if (get().generating) return { ok: false, error: "Another generation is already starting." };
    const item = findItem(get(), id);
    if (!item || item.seed == null) return { ok: false, error: "The original seed is unavailable." };
    const cloned = await get().cloneToComposer(id);
    if (cloned?.ok === false) return cloned;
    if (cloned?.notice) return { ok: true };
    set({ seed: item.seed });
    if (!get().prompt.trim()) return { ok: false, error: "The saved prompt is empty." };
    await get().generate();
    return { ok: true };
  },

  /**
   * Multi-shot chaining (Phase 3.3) — "Continue this shot". Unlike
   * regenerate/regenerateWithSameSeed, this deliberately does NOT
   * auto-submit: it loads the extracted frame into the composer and clears
   * the prompt so the user writes what happens NEXT, then generates
   * normally. Gated on config.supportsFirstFrameContinuation — the caller
   * (DetailModal) should already only show this action for a model that
   * supports it, but this re-checks so a stale button (composer switched
   * models after the item finished) can't silently submit a continuation
   * frame nothing will act on.
   */
  continueShot: async (id) => {
    const item = findItem(get(), id);
    if (!item || item.kind !== "video" || item.status !== "succeeded" || !item.url) {
      return { ok: false, error: "This video is not available for continuation." };
    }
    if (!supportsFirstFrameContinuation(item.model)) {
      return { ok: false, error: `${item.model} doesn't support continuing a shot yet.` };
    }
    const choice = composerChoice(item.model, "video", get().availableModelIds);
    if (!choice.model) return { ok: false, error: choice.notice };
    try {
      const { extractFrame } = await import("./video-frame");
      // Infinity is clamped to (duration - 0.05) by seekTo — the same
      // last-frame convention video-frame-server.js's ffmpeg path uses
      // server-side (-sseof -1), just expressed for the browser API instead.
      const { dataUrl } = await extractFrame(inlineMediaUrl(item.url), Infinity);
      set({
        mode: "video",
        model: item.model,
        aspectRatio: item.aspectRatio,
        resolution: item.resolution ?? get().resolution,
        continuationFrame: dataUrl,
        firstFrame: dataUrl,
        lastFrame: null,
        firstFrameMode: true,
        productionContext: { sourceGenerationId: item.id, relation: "continuation", frame: "last" },
        destinationProjectId: item.projectId,
        destinationFolderId: item.folderId ?? null,
        referenceVideos: [],
        videoNotes: [],
        referenceAudios: [],
        stagedReferenceVideos: [],
        stagedContinuationFrame: null,
        seed: null,
        videoTaskMode: "generate",
        prompt: "",
        referenceImages: [],
        referenceKinds: [],
      });
      if (choice.notice) {
        applyFallbackModel(get, set, choice.model);
        notify(choice.notice, { tone: "info" });
      }
      return { ok: true };
    } catch (e) {
      console.error("Failed to extract the last frame for continuation:", e);
      return { ok: false, error: e?.message || "Could not read the last frame from this video." };
    }
  },

  finalizeDraft: async (id) => {
    try {
      const res = await apiFetch("/api/generate/video/finalize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceGenerationId: id }),
      });
      const item = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: apiErrorMessage(item, res.status) };
      insertNewItem(set, item);
      return { ok: true, item };
    } catch (error) {
      return { ok: false, error: error?.message || "Could not start the final render." };
    }
  },

  addReferenceFromVideo: async (url, atSeconds) => {
    // No provider here accepts an uploaded video, so a frame is how a clip
    // becomes usable as a reference at all. Decoded in the browser — see
    // lib/video-frame.ts for why this cannot happen server-side.
    try {
      const { extractFrame } = await import("./video-frame");
      const { dataUrl } = await extractFrame(inlineMediaUrl(url), atSeconds);
      const { uploadOriginalReference } = await import("./client-reference-upload");
      const blob = await (await fetch(dataUrl)).blob();
      get().addReference(await uploadOriginalReference(new File([blob], "video-frame.png", {type:blob.type})), "video");
    } catch (e) {
      console.error("Failed to take a frame from video:", e);
      notify(e?.message || "Could not read a frame from this video.");
    }
  },

  setAsFirstFrame: async (url) => {
    try {
      let dataUrl;
      if (typeof url === "string" && url.startsWith("data:")) {
        dataUrl = url;
      } else {
        dataUrl = await encodeBlobWithBudget(await fetchFrameBlob(url));
      }
      const targetModel = supportsFirstLastFrame(get().model) ? get().model : "Seedance 2.5";
      set({
        mode: "video",
        model: targetModel,
        firstFrame: dataUrl,
        continuationFrame: dataUrl,
        firstFrameMode: true,
      });
      return { ok: true };
    } catch (e) {
      console.error("Failed to set first frame from URL:", e);
      return { ok: false, error: e?.message || "Failed to load frame." };
    }
  },

  setAsLastFrame: async (url) => {
    try {
      let dataUrl;
      if (typeof url === "string" && url.startsWith("data:")) {
        dataUrl = url;
      } else {
        dataUrl = await encodeBlobWithBudget(await fetchFrameBlob(url));
      }
      const targetModel = supportsFirstLastFrame(get().model) ? get().model : "Seedance 2.5";
      set({
        mode: "video",
        model: targetModel,
        lastFrame: dataUrl,
        firstFrameMode: true,
      });
      return { ok: true };
    } catch (e) {
      console.error("Failed to set last frame from URL:", e);
      return { ok: false, error: e?.message || "Failed to load frame." };
    }
  },

  setVideoFrameAsFirstFrame: async (url, atSeconds) => {
    try {
      const { extractFrame } = await import("./video-frame");
      const { dataUrl } = await extractFrame(inlineMediaUrl(url), atSeconds);
      const targetModel = supportsFirstLastFrame(get().model) ? get().model : "Seedance 2.5";
      set({
        mode: "video",
        model: targetModel,
        firstFrame: dataUrl,
        continuationFrame: dataUrl,
        firstFrameMode: true,
      });
      return { ok: true };
    } catch (e) {
      console.error("Failed to use video frame as first frame:", e);
      return { ok: false, error: e?.message || "Could not read frame from this video." };
    }
  },

  setVideoFrameAsLastFrame: async (url, atSeconds) => {
    try {
      const { extractFrame } = await import("./video-frame");
      const { dataUrl } = await extractFrame(inlineMediaUrl(url), atSeconds);
      const targetModel = supportsFirstLastFrame(get().model) ? get().model : "Seedance 2.5";
      set({
        mode: "video",
        model: targetModel,
        lastFrame: dataUrl,
        firstFrameMode: true,
      });
      return { ok: true };
    } catch (e) {
      console.error("Failed to use video frame as last frame:", e);
      return { ok: false, error: e?.message || "Could not read frame from this video." };
    }
  },

  cloneToComposer: async (id) => {
    const item = findItem(get(), id);
    if (!item) return { ok: false, error: "This generation is no longer available." };
    if (isMagnificUpscale(item)) {
      if (!(item.kind === "video" ? item.referenceVideos?.[0] : item.referenceImages?.[0])) {
        return { ok: false, error: "The original upscale source is no longer available." };
      }
      return reopenUpscale(get, set, item, { destinationProjectId: item.projectId, destinationFolderId: item.folderId ?? null });
    }
    // A model new jobs may not use (switched off on the server) reopens on the picker's fallback,
    // saying so, rather than leaving the composer on a model enqueue refuses.
    const choice = item.kind === "image" || item.kind === "video"
      ? composerChoice(item.model, item.kind, get().availableModelIds)
      : { model: composerModel(item.model), notice: null };
    if (!choice.model) return { ok: false, error: choice.notice };
    set({
      mode: item.kind,
      // A row made with a retired model reuses its replacement. Gemini Omni Flash's 16:9/9:16, 720p and
      // 4/6/8s all exist on Gemini Omni Flash 1.1, so the stored settings below stay valid.
      model: composerModel(item.model),
      productionContext: { sourceGenerationId: item.id, relation: "clone" },
      destinationProjectId: item.projectId,
      destinationFolderId: item.folderId ?? null,
        referenceVideos: item.referenceVideos ?? [],
        referenceAudios: item.referenceAudios ?? [],
        audioNotes: (item.referenceAudios ?? []).map((ref, i) => ({ref,name:`Audio ${i+1}`})),
      stagedReferenceVideos: [],
      stagedContinuationFrame: null,
      aspectRatio: item.aspectRatio,
      resolution: item.resolution ?? get().resolution,
      duration: item.duration ?? get().duration,
      generateAudio: item.generateAudio === true && supportsAudio(item.model),
      draftMode: item.draftMode === true && supportsDraftMode(item.model),
      bitrateMode:
        supportsBitrateMode(item.model) && item.bitrateMode === "standard" ? "standard" : "high",
      videoTaskMode: supportsVideoEditExtend(item.model)
        ? item.videoTaskMode ?? "generate"
        : "generate",
      // A plain clone starts fresh, not pinned — regenerateWithSameSeed sets
      // this explicitly right after calling cloneToComposer.
      seed: null,
      // Same reasoning — continueShot below sets this itself, after loading
      // its own extracted frame, not by going through cloneToComposer at all.
      continuationFrame: null,
      prompt: item.prompt,
      referenceImages: [],
      referenceKinds: [],
    });
    const paths = item.referenceImages ?? [];
    set({ referenceImages: [...paths], referenceIds: paths.map(() => newReferenceId()),
      referenceKinds: paths.map(() => "image"), referenceLabels: paths.map(() => ""), referenceTags: paths.map(() => "") });
    if (!choice.notice) return { ok: true };
    applyFallbackModel(get, set, choice.model);
    notify(choice.notice, { tone: "info" });
    return { ok: true, notice: choice.notice };
  },

  loadAssets: async (projectId) => {
    const pid = projectId !== undefined ? projectId : get().activeProjectId;
    const key = materialKey(pid);
    const cached = getMaterialCache(key);
    if (cached) {
      set({ assets: cached.items, assetsLoading: false, assetsError: null, assetsKey: key });
      if (isMaterialFresh(cached)) return;
      set({ assetsRefreshing: true });
    } else {
      set({ assets: [], assetsLoading: true, assetsRefreshing: false, assetsError: null, assetsKey: key });
    }
    try {
      const url = pid ? `/api/assets?projectId=${encodeURIComponent(pid)}` : "/api/assets";
      const json = await dedupeMaterialRequest(key, async () => {
        const res = await apiFetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`Material request failed (${res.status})`);
        return res.json();
      });
      const items = json.assets ?? [];
      putMaterialCache(key, { items, at: Date.now() });
      if (get().assetsKey === key) set({ assets: items, assetsError: null });
    } catch (error) {
      if (get().assetsKey === key) set({ assetsError: error?.message || "Could not load materials." });
    } finally {
      if (get().assetsKey === key) set({ assetsLoading: false, assetsRefreshing: false });
    }
  },

  saveAsset: async (draft) => {
    try {
      const payload = {
        ...draft,
        projectId: draft.projectId ?? get().activeProjectId ?? undefined,
      };
      const res = await apiFetch("/api/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.id) {
        return { ok: false, error: apiErrorMessage(data, res.status) };
      }
      set((s) => ({
        assets: [data, ...s.assets.filter((a) => a.id !== data.id)],
        editingAsset: null,
      }));
      patchMaterialCaches(data);
      return { ok: true, asset: data };
    } catch (err) {
      return { ok: false, error: err?.message || "Failed to save asset." };
    }
  },

  deleteAsset: async (id) => {
    const asset = get().assets.find((candidate) => candidate.id === id);
    if (!asset) return { ok: false, error: "This asset is no longer available." };
    set((s) => ({ assets: s.assets.filter((a) => a.id !== id) }));
    dropMaterialCaches(id);
    try {
      const res = await apiFetch(`/api/assets?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(apiErrorMessage(body, res.status));
      }
      return { ok: true };
    } catch (e) {
      set((s) => ({
        assets: s.assets.some((candidate) => candidate.id === id)
          ? s.assets
          : [asset, ...s.assets],
      }));
      patchMaterialCaches(asset);
      return { ok: false, error: e.message || "Failed to delete the asset." };
    }
  },

  setAssetLibraryOpen: (assetLibraryOpen) => set({ assetLibraryOpen }),
  attachMaterialToComposer: (asset) => {
    if (!asset) return;
    const imageUrl = asset.images?.[0] || asset.thumb || "";
    if (!imageUrl) return;
    const tag = `@${asset.slug}`;
    set((s) => {
      const existingIdx = s.referenceImages.indexOf(imageUrl);
      let referenceImages = s.referenceImages;
      let referenceKinds = s.referenceKinds;
      let referenceLabels = Array.isArray(s.referenceLabels) ? [...s.referenceLabels] : [];
      let referenceTags = Array.isArray(s.referenceTags) ? [...s.referenceTags] : [];

      if (existingIdx === -1) {
        referenceImages = [...referenceImages, imageUrl];
        referenceKinds = [...referenceKinds, "material"];
        referenceLabels.push(asset.name || "");
        referenceTags.push(tag);
      }

      let prompt = s.prompt || "";
      if (!prompt.includes(tag)) {
        prompt = prompt.trim().length > 0 ? `${prompt.trim()} ${tag} ` : `${tag} `;
      }

      const resolutions = resolutionsForModel(s.model, s.mode, referenceImages.length > 0);
      return {
        referenceImages,
        referenceKinds,
        referenceLabels,
        referenceTags,
        prompt,
        assetLibraryOpen: false,
        resolution: resolutions.includes(s.resolution)
          ? s.resolution
          : resolutions[resolutions.length - 1],
      };
    });
  },
  setEditingAsset: (editingAsset) => set({ editingAsset }),

  setPortraitGalleryOpen: (portraitGalleryOpen) => set({ portraitGalleryOpen }),

  loadPortraits: async ({ more = false, refresh = false, query } = {}) => {
    const before = get().portraits;
    if (more && (!before.next || before.loading || before.loadingMore)) return;
    if (refresh && portraitRuntime.refreshing) return;
    const fresh = !more && !refresh;
    const q = fresh && typeof query === "string" ? query : before.query;
    const token = fresh ? ++portraitRuntime.token : portraitRuntime.token;
    const requestId = ++portraitRuntime.listSeq;
    if (fresh) {
      portraitRuntime.attempt = 0;
      set({ portraits: { ...before, query: q, loading: true, error: null } });
    } else if (more) set({ portraits: { ...before, loadingMore: true } });
    else portraitRuntime.refreshing = true;
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (more) params.set("cursor", before.next);
      if (q) params.set("q", q);
      const res = await apiFetch(`/api/portraits?${params}`, { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiErrorMessage(json, res.status, "Could not load portraits."));
      if (token !== portraitRuntime.token) return;
      // A portrait the person just deleted can still be in a page requested before the delete landed,
      // even when that page resolves after it. Only a request made after the delete can be trusted.
      const stale = (id) => requestId <= (portraitRuntime.deleting.get(id) ?? 0);
      const page = (Array.isArray(json.portraits) ? json.portraits : []).filter((item) => !stale(item.id));
      for (const [id, until] of portraitRuntime.deleting) if (until < requestId) portraitRuntime.deleting.delete(id);
      const next = json.next ?? null;
      const pendingBefore = get().portraits.items.filter(isPortraitPending).length;
      set((state) => {
        const current = state.portraits;
        const settled = { loading: false, loadingMore: false, error: null, query: q };
        if (json.enabled !== true) return { portraits: { ...current, ...settled, enabled: false, items: [], next: null } };
        if (more) return { portraits: { ...current, ...settled, enabled: true, items: appendPortraitPage(current.items, page), next } };
        if (refresh) {
          const merged = mergePortraitPage(current.items, page, next);
          return { portraits: { ...current, ...settled, enabled: true, items: merged.items, next: merged.keepNext ? current.next : next } };
        }
        return { portraits: { ...current, ...settled, enabled: true, items: page, next } };
      });
      if (get().portraits.items.filter(isPortraitPending).length !== pendingBefore) portraitRuntime.attempt = 0;
    } catch (error) {
      if (token === portraitRuntime.token) {
        set((state) => ({ portraits: { ...state.portraits, loading: false, loadingMore: false, error: error.message || "Could not load portraits." } }));
      }
    } finally {
      if (refresh) portraitRuntime.refreshing = false;
      schedulePortraitPoll(get);
    }
  },

  // Bytes go straight to storage three at a time; the finished ones are then registered with the
  // gallery in the order they were dropped, so the first dropped is the first prepared. That order
  // holds across overlapping drops: a drop registers only after every earlier drop has settled.
  uploadPortraits: async (files) => {
    const list = Array.from(files || []);
    if (!list.length) return { added: 0, failed: 0 };
    portraitRuntime.attempt = 0;
    const entries = list.map((file) => ({
      key: `${Date.now().toString(36)}-${++portraitRuntime.uploadSeq}`,
      name: portraitNameFromFile(file),
      state: "uploading",
      progress: 0,
      error: null,
      previewUrl: typeof Blob !== "undefined" && file instanceof Blob && typeof URL.createObjectURL === "function" && file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
    }));
    set((state) => ({ portraitUploads: [...entries, ...state.portraitUploads] }));
    const patch = (key, fields) => set((state) => ({
      portraitUploads: state.portraitUploads.map((upload) => (upload.key === key ? { ...upload, ...fields } : upload)),
    }));
    const drop = (key) => set((state) => {
      const gone = state.portraitUploads.find((upload) => upload.key === key);
      if (gone?.previewUrl) URL.revokeObjectURL?.(gone.previewUrl);
      return { portraitUploads: state.portraitUploads.filter((upload) => upload.key !== key) };
    });
    let added = 0, failed = 0;
    const fail = (key, message) => { failed += 1; patch(key, { state: "error", error: message }); };
    const registrar = createOrderedRegistrar(list.length, async (batch) => {
      for (const item of batch) patch(entries[item.index].key, { state: "registering", progress: 100 });
      try {
        const res = await apiFetch("/api/portraits", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uploads: batch.map(({ referenceId, name }) => ({ referenceId, name })) }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(apiErrorMessage(json, res.status, "Could not add these images to the gallery."));
        const results = Array.isArray(json.results) ? json.results : [];
        const accepted = [];
        batch.forEach((item, position) => {
          const result = results.find((r) => r.referenceId === item.referenceId) || results[position];
          if (result?.ok && result.portrait) {
            accepted.push(result.portrait);
            drop(entries[item.index].key);
          } else fail(entries[item.index].key, result?.message || "This image couldn't be added.");
        });
        added += accepted.length;
        if (accepted.length) {
          set((state) => {
            const known = new Set(accepted.map((p) => p.id));
            const needle = state.portraits.query.trim().toLowerCase();
            const shown = accepted.filter((p) => !needle || String(p.name || "").toLowerCase().includes(needle));
            return { portraits: { ...state.portraits, enabled: true, items: sortPortraits([...shown, ...state.portraits.items.filter((p) => !known.has(p.id))]) } };
          });
        }
      } catch (error) {
        for (const item of batch) fail(entries[item.index].key, error?.message || "Could not add this image. Try again.");
      }
      schedulePortraitPoll(get);
    }, portraitRuntime.registrationTail);
    portraitRuntime.registrationTail = registrar.finished;
    schedulePortraitPoll(get);
    await runPool(list, PORTRAIT_UPLOAD_CONCURRENCY, async (file, index) => {
      const { key, name } = entries[index];
      let problem = portraitFileProblem(file);
      if (!problem) {
        const size = await readPortraitDimensions(file);
        if (size) problem = portraitDimensionProblem(size.width, size.height);
      }
      if (problem) {
        fail(key, problem);
        void registrar.settle(index, null);
        return;
      }
      try {
        const ready = await uploadFileDirect(file, "portrait", {
          onProgress: ({ uploadedBytes, totalBytes }) => {
            const progress = Math.min(99, Math.floor((uploadedBytes / Math.max(1, totalBytes)) * 100));
            const current = get().portraitUploads.find((upload) => upload.key === key);
            if (current && current.progress !== progress) patch(key, { progress });
          },
        });
        void registrar.settle(index, { referenceId: ready.referenceId, name });
      } catch (error) {
        fail(key, error?.message || "Upload failed. Try again.");
        void registrar.settle(index, null);
      }
    });
    await registrar.done();
    return { added, failed };
  },
  dismissPortraitUpload: (key) => set((state) => {
    const gone = state.portraitUploads.find((upload) => upload.key === key);
    if (gone?.previewUrl) URL.revokeObjectURL?.(gone.previewUrl);
    return { portraitUploads: state.portraitUploads.filter((upload) => upload.key !== key) };
  }),

  renamePortrait: async (id, name) => {
    const clean = String(name || "").trim().slice(0, 120);
    if (!clean) return { ok: false, error: "Enter a name." };
    try {
      const res = await apiFetch(`/api/portraits/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: clean }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.portrait) return { ok: false, error: apiErrorMessage(json, res.status, "Could not rename this portrait.") };
      set((state) => ({ portraits: { ...state.portraits, items: state.portraits.items.map((item) => (item.id === id ? { ...item, ...json.portrait } : item)) } }));
      return { ok: true, portrait: json.portrait };
    } catch {
      return { ok: false, error: "Could not rename this portrait. Try again." };
    }
  },

  // One request for the whole selection. The cards leave at once; any the server refused come back.
  deletePortraits: async (ids) => {
    const unique = [...new Set(ids || [])];
    if (!unique.length) return { ok: true, removed: 0, failed: [] };
    const removedItems = get().portraits.items.filter((item) => unique.includes(item.id));
    for (const id of unique) portraitRuntime.deleting.set(id, Infinity);
    set((state) => ({ portraits: { ...state.portraits, items: state.portraits.items.filter((item) => !unique.includes(item.id)) } }));
    let failed = [];
    try {
      const res = await apiFetch("/api/portraits/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: unique }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(apiErrorMessage(json, res.status, "Could not delete these portraits."));
      const results = Array.isArray(json.results) ? json.results : [];
      // NOT_FOUND means someone else already removed it from the shared gallery.
      failed = unique
        .map((id) => ({ id, result: results.find((r) => r.id === id) }))
        .filter(({ result }) => !(result?.ok || result?.error === "NOT_FOUND"))
        .map(({ id, result }) => ({ id, error: result?.message || "Could not delete this portrait." }));
    } catch (error) {
      failed = unique.map((id) => ({ id, error: error?.message || "Could not delete these portraits. Try again." }));
    } finally {
      // Lists requested up to now may still carry the deleted cards; refused ones are not hidden at all.
      for (const id of unique) {
        if (failed.some((f) => f.id === id)) portraitRuntime.deleting.delete(id);
        else portraitRuntime.deleting.set(id, portraitRuntime.listSeq);
      }
    }
    if (failed.length) {
      const back = removedItems.filter((item) => failed.some((f) => f.id === item.id));
      set((state) => ({ portraits: { ...state.portraits, items: sortPortraits([...back, ...state.portraits.items.filter((item) => !back.some((b) => b.id === item.id))]) } }));
    }
    return { ok: failed.length === 0, removed: unique.length - failed.length, failed };
  },

  // Adds the portraits as "portrait" references labelled with their names, then closes the gallery once.
  attachPortraitsToComposer: (portraits) => {
    const unique = [...new Map((portraits || []).filter(Boolean).map((p) => [p.id || p.imageUrl, p])).values()];
    if (unique.some((p) => !portraitAttachable(p))) return { ok: false, error: "Portraits that can't be used can't be added to a prompt." };
    const state = get();
    if (state.referenceImages.length + state.referenceVideos.length + state.referenceAudios.length + unique.length > 50) {
      return { ok: false, error: "Stage at most 50 references; remove some attachments first." };
    }
    // A portrait already in the prompt can be added again: each occurrence keeps its own reference id.
    for (const p of unique) get().addReference(p.imageUrl, "portrait", p.name || "Portrait");
    set({ portraitGalleryOpen: false });
    return { ok: true, count: unique.length };
  },
  loadProjects: async () => {
    try {
      // GET ensures a default project server-side (atomic — no duplicate races).
      const res = await apiFetch("/api/projects", { cache: "no-store" });
      const json = await res.json();
      const projects = json.projects ?? [];
      const currentActiveId = get().activeProjectId;
      const nextProjectId =
        currentActiveId && projects.some((p) => p.id === currentActiveId)
          ? currentActiveId
          : currentActiveId === null && (get().projects.length > 0 || get().projectScopeSelected)
          ? null
          : projects[0]?.id ?? null;
      set({
        projects,
        activeProjectId: nextProjectId,
      });
      if (nextProjectId) {
        void get().loadAssets(nextProjectId);
      }
      void get().loadLibraryTree();
    } catch {
      /* ignore */
    }
  },

  loadLibraryTree: async () => {
    try {
      const res = await apiFetch("/api/folders?tree=1", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      set({
        libraryTree: {
          globalFolders: data.globalFolders ?? [],
          projects: data.projects ?? [],
        },
        globalFolders: data.globalFolders ?? [],
      });
    } catch {
      /* ignore */
    }
  },

  // The subscription at the bottom of this file watches these and refetches the
  // feed, counts and thread — so switching project or folder is one state write
  // here, not a fetch every caller has to remember to make.
  setActiveProject: (id) =>
    set((s) => ({
      activeProjectId: id,
      activeFolderId: null,
      projectScopeSelected: true,
      ...(s.activeProjectId !== id ? CLEAR_SELECTION_PATCH : {}),
    })),
  setActiveFolder: (id) =>
    set((s) => ({
      activeFolderId: id,
      ...(s.activeFolderId !== id ? CLEAR_SELECTION_PATCH : {}),
    })),

  createProject: async (name) => {
    const res = await apiFetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "createProject", name }),
    });
    const json = await res.json();
    if (json.projects) {
      set((s) => ({
        projects: json.projects,
        activeProjectId: json.project?.id ?? s.activeProjectId,
        activeFolderId: null,
        ...CLEAR_SELECTION_PATCH,
      }));
      void get().loadLibraryTree();
    }
  },

  renameProject: async (id, name) => {
    const res = await apiFetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "renameProject", projectId: id, name }),
    });
    const json = await res.json();
    if (json.projects) {
      set({ projects: json.projects });
      void get().loadLibraryTree();
    }
  },

  deleteProject: async (id) => {
    const res = await apiFetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "deleteProject", projectId: id }),
    });
    const json = await res.json();
    if (json.projects) {
      const projects = json.projects;
      set((s) => ({
        projects,
        activeProjectId:
          s.activeProjectId === id ? projects[0]?.id ?? null : s.activeProjectId,
        activeFolderId: s.activeProjectId === id ? null : s.activeFolderId,
        ...(s.activeProjectId === id ? CLEAR_SELECTION_PATCH : {}),
      }));
      // Items got orphaned server-side. That is a membership change across
      // every project-scoped view at once, so refetch rather than trying to
      // patch each cached scope into a consistent state.
      invalidateFeedCache();
      void get().loadFeed({ force: true });
      void get().loadCounts();
      void get().loadThread();
      void get().loadLibraryTree();
    }
  },

  createFolder: async (arg1, arg2, arg3, customIdempotencyKey) => {
    let name, projectId, parentId, idempotencyKey;
    if (typeof arg1 === "object" && arg1 !== null) {
      ({ name, projectId = null, parentId = null, idempotencyKey } = arg1);
    } else {
      projectId = arg1 || null;
      name = arg2;
      parentId = arg3 || null;
      idempotencyKey = customIdempotencyKey;
    }
    if (!idempotencyKey) {
      idempotencyKey = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : undefined;
    }
    const res = await apiFetch("/api/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, projectId, parentId, idempotencyKey }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(apiErrorMessage(err, res.status, "Failed to create folder"));
    }
    const json = await res.json();
    if (json.folder?.id) {
      set({ activeProjectId: json.folder.projectId ?? null, activeFolderId: json.folder.id, projectScopeSelected: true });
    }
    await Promise.all([get().loadProjects(), get().loadLibraryTree(), get().loadCounts()]);
    return json.folder;
  },

  renameFolder: async (arg1, arg2, arg3, arg4, customIdempotencyKey) => {
    let folderId, name, projectId, expectedVersion, idempotencyKey;
    if (typeof arg1 === "object" && arg1 !== null) {
      ({ id: folderId, name, projectId, expectedVersion, idempotencyKey } = arg1);
    } else if (arg3 !== undefined && typeof arg3 === "string") {
      projectId = arg1;
      folderId = arg2;
      name = arg3;
      expectedVersion = arg4;
      idempotencyKey = customIdempotencyKey;
    } else {
      folderId = arg1;
      name = arg2;
      expectedVersion = arg3;
      idempotencyKey = typeof arg4 === "string" ? arg4 : undefined;
    }
    if (expectedVersion === undefined) {
      const tree = get().libraryTree;
      const findNode = (nodes) => {
        if (!Array.isArray(nodes)) return null;
        for (const n of nodes) {
          if (n.id === folderId) return n;
          const found = findNode(n.children || n.folders);
          if (found) return found;
        }
        return null;
      };
      const found = findNode(tree?.globalFolders) || findNode(tree?.projects);
      if (found?.version) expectedVersion = found.version;
    }
    if (!idempotencyKey) {
      idempotencyKey = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : undefined;
    }
    const res = await apiFetch("/api/folders", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: folderId, name, projectId, expectedVersion, idempotencyKey }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (err.code === "VERSION_CONFLICT") await get().loadLibraryTree();
      throw Object.assign(new Error(apiErrorMessage(err, res.status, "Failed to rename folder")), { code: err.code, status: res.status });
    }
    await Promise.all([get().loadProjects(), get().loadLibraryTree()]);
  },

  setFolderColor: async (folderId, color, customIdempotencyKey) => {
    let idempotencyKey = customIdempotencyKey;
    if (!idempotencyKey) {
      idempotencyKey = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : undefined;
    }
    const res = await apiFetch("/api/folders", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: folderId, color, idempotencyKey }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw Object.assign(new Error(apiErrorMessage(err, res.status, "Failed to set folder color")), { code: err.code, status: res.status });
    }
    await Promise.all([get().loadProjects(), get().loadLibraryTree()]);
  },

  deleteFolder: async (arg1, arg2, customIdempotencyKey) => {
    let folderId, projectId, idempotencyKey;
    if (typeof arg1 === "object" && arg1 !== null) {
      ({ folderId, projectId, idempotencyKey } = arg1);
    } else if (arg2 !== undefined && typeof arg2 === "string") {
      projectId = arg1;
      folderId = arg2;
      idempotencyKey = customIdempotencyKey;
    } else {
      folderId = arg1;
      idempotencyKey = typeof arg2 === "string" ? arg2 : undefined;
    }
    if (!idempotencyKey) {
      idempotencyKey = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : undefined;
    }
    const params = new URLSearchParams({ id: folderId });
    if (projectId) params.set("projectId", projectId);
    if (idempotencyKey) params.set("idempotencyKey", idempotencyKey);
    const res = await apiFetch(`/api/folders?${params}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(apiErrorMessage(err, res.status, "Failed to delete folder"));
    }
    set((s) => ({
      activeFolderId: s.activeFolderId === folderId ? null : s.activeFolderId,
    }));
    invalidateFeedCache();
    await Promise.all([
      get().loadProjects(),
      get().loadLibraryTree(),
      get().loadFeed({ force: true }),
      get().loadCounts(),
    ]);
  },

  moveFolder: async (folderId, destination, expectedVersion = undefined, customIdempotencyKey = undefined) => {
    if (expectedVersion === undefined) {
      const tree = get().libraryTree;
      const findNode = (nodes) => {
        if (!Array.isArray(nodes)) return null;
        for (const n of nodes) {
          if (n.id === folderId) return n;
          const found = findNode(n.children || n.folders);
          if (found) return found;
        }
        return null;
      };
      const found = findNode(tree?.globalFolders) || findNode(tree?.projects);
      if (found?.version) expectedVersion = found.version;
    }
    const idempotencyKey = customIdempotencyKey || (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : undefined);
    const res = await apiFetch("/api/folders", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: folderId, destination, expectedVersion, idempotencyKey }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw Object.assign(new Error(apiErrorMessage(err, res.status, "Failed to move folder")), {code:err.code,status:res.status});
    }
    invalidateFeedCache();
    await Promise.all([
      get().loadProjects(),
      get().loadLibraryTree(),
      get().loadFeed({ force: true }),
      get().loadCounts(),
    ]);
    return await res.json();
  },

  moveGenerationsToDestination: async (ids, destination, expectedVersions = undefined, customIdempotencyKey = undefined) => {
    if (!Array.isArray(ids) || ids.length === 0 || !destination) return false;
    const expVers = expectedVersions ? { ...expectedVersions } : {};
    if (!expectedVersions) {
      const items = get().items || [];
      for (const id of ids) {
        const it = items.find((x) => x.id === id);
        if (it && typeof it.locationVersion === "number") {
          expVers[id] = it.locationVersion;
        }
      }
    }
    const idempotencyKey = customIdempotencyKey || (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : undefined);
    const res = await apiFetch("/api/history/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ids,
        destination,
        expectedVersions: Object.keys(expVers).length > 0 ? expVers : undefined,
        idempotencyKey,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      invalidateFeedCache();
      void get().loadFeed({ force: true });
      void get().loadCounts();
      throw Object.assign(new Error(apiErrorMessage(err, res.status, "Failed to move items.")), {code:err.code,status:res.status});
    }
    const committed = await res.json();
    invalidateFeedCache();
    set({ selectedIds: [] });
    await Promise.all([
      get().loadFeed({ force: true }),
      get().loadCounts(),
      get().loadThread(),
    ]);
    return {ok:true,...committed};
  },

  moveItem: async (itemId, destinationOrFolderId) => {
    let destination;
    if (typeof destinationOrFolderId === "object" && destinationOrFolderId !== null) {
      destination = destinationOrFolderId;
    } else {
      const folderId = destinationOrFolderId ?? null;
      const projectId = get().activeProjectId ?? null;
      if (projectId) {
        destination = folderId
          ? { type: "folder", folderId, projectId }
          : { type: "project_unsorted", projectId };
      } else {
        destination = folderId
          ? { type: "folder", folderId }
          : { type: "global_unsorted" };
      }
    }
    return get().moveGenerationsToDestination([itemId], destination);
  },

  singleSelect: (id) =>
    set({
      selectedIds: [id],
      focusedAssetId: id,
      selectionAnchorId: id,
    }),

  toggleSelect: (id) =>
    set((s) => ({
      selectedIds: s.selectedIds.includes(id)
        ? s.selectedIds.filter((x) => x !== id)
        : [...s.selectedIds, id],
      focusedAssetId: id,
      selectionAnchorId: id,
    })),

  selectRange: (targetId, allIds = []) =>
    set((s) => {
      if (!allIds || allIds.length === 0) {
        return { selectedIds: [targetId], focusedAssetId: targetId, selectionAnchorId: targetId };
      }
      const anchor = s.selectionAnchorId && allIds.includes(s.selectionAnchorId) ? s.selectionAnchorId : targetId;
      const anchorIdx = allIds.indexOf(anchor);
      const targetIdx = allIds.indexOf(targetId);
      if (anchorIdx === -1 || targetIdx === -1) {
        return { selectedIds: [targetId], focusedAssetId: targetId, selectionAnchorId: targetId };
      }
      const start = Math.min(anchorIdx, targetIdx);
      const end = Math.max(anchorIdx, targetIdx);
      const rangeIds = allIds.slice(start, end + 1);
      return {
        selectedIds: rangeIds,
        focusedAssetId: targetId,
      };
    }),

  selectAll: (ids) => set({ selectedIds: ids }),
  clearSelection: () => set({ selectedIds: [], focusedAssetId: null, selectionAnchorId: null }),

  moveItemsToProject: async (ids, projectId, folderId = null) => {
    if (!ids?.length) return;
    const destination = folderId
      ? { type: "folder", folderId, projectId }
      : { type: "project_root", projectId };
    return get().moveGenerationsToDestination(ids, destination);
  },

  loadMe: async () => {
    try {
      const res = await apiFetch("/api/auth/me", { cache: "no-store" });
      const json = await res.json();
      if (json.user) {
        set({ currentUser: json.user });
        get().applyModelAvailability(json.availability?.models);
        // The list response owns managed-portrait availability. Resolve it before
        // anyone opens the attachment menu, including when the gallery is off.
        await get().loadPortraits();
      } else window.location.href = "/login";
    } catch {
      /* ignore */
    }
  },

  // A failed or malformed answer keeps what the pickers already show; enqueue still refuses.
  applyModelAvailability: (value) => {
    const ids = availabilityIds(value);
    if (!ids) return;
    cacheAvailability(ids);
    const known = get().availableModelIds;
    if (!known || known.join("\n") !== ids.join("\n") || !get().availabilityAnswered) {
      set({ availableModelIds: ids, availabilityAnswered: true });
    }
    reconcileAvailability(get, set);
  },

  // Failure leaves `limits` empty rather than throwing — call sites fall
  // back to each limit's own registry default (src/lib/limits.ts) in that
  // case, so a fetch hiccup never makes every prompt look "too long"
  // client-side. The server enforces the real admin value regardless; this
  // is display/UX only, never the source of truth.
  loadLimits: async () => {
    try {
      const res = await apiFetch("/api/settings", { cache: "no-store" });
      const json = await res.json();
      if (json && typeof json === "object") set({ limits: json });
    } catch {
      /* ignore */
    }
  },

  loadUsers: async () => {
    try {
      const res = await apiFetch("/api/users", { cache: "no-store" });
      const json = await res.json();
      const map = {};
      for (const u of json.users ?? []) map[u.id] = u;
      set({ usersById: map });
    } catch {
      /* ignore */
    }
  },

  logout: async () => {
    const actorId = get().currentUser?.id;
    set(cleanLibraryQuery());
    try {
      clearFeedCache();
      clearMaterialCache();
      await apiFetch("/api/auth/logout", { method: "POST" });
    } catch {
      /* ignore */
    }
    disposeStoreRuntime();
    clearLibrarySession(actorId);
    window.location.href = "/login";
  },
}));

installOperationTracking(useStore);

// Normalize legacy clone/restore paths as they enter shared draft state.
useStore.subscribe((state, previous) => {
  if (state.referenceImages === previous.referenceImages && state.referenceIds === previous.referenceIds) return;
  const ids = referenceIdsFor(state);
  if (JSON.stringify(ids) !== JSON.stringify(state.referenceIds)) useStore.setState({ referenceIds: ids });
});

/**
 * Merge server rows into the store without losing local truth — and without
 * moving anything the user is currently looking at.
 *
 * Rules, each guarding a specific way this could go wrong:
 *  - Only overwrite when the incoming row is strictly newer by updatedAt, so a
 *    slow live poll can't clobber a fresher result already received from Django.
 *  - Preserve queueNote, which is client-only and transient (it never round
 *    trips through the DB), but drop it once the item leaves the queue.
 *  - Only consider rows that belong in the scope on screen. The feed is a
 *    server-filtered query now, so splicing in a row from another project would
 *    show something a refetch immediately removes.
 *  - Only INSERT rows that sort within the pages we've loaded, or are still in
 *    flight under a descending sort. items is a paginated window; splicing a
 *    row from a later page into it creates a hole that pagination then
 *    duplicates or skips. Under oldest first, in-flight work is the newest and
 *    so belongs on a later page too.
 *  - **Never insert above the viewport while the user is scrolled.** An update
 *    to a row already on screen is a repaint in place and always applied; a new
 *    row is an insertion at the head, which shifts every card below it. That
 *    shift is the "it keeps moving around while I scroll" complaint, so new
 *    arrivals are buffered into `pendingItems` and surfaced as a count the user
 *    can act on. When the grid is at the top (`feedPinned`) there is nothing
 *    above to displace, so they go straight in.
 */
export function mergeLiveItems(
  incoming,
  set
) {
  if (!incoming.length) return;
  set((s) => {
    const scope = currentScope(s);
    const byId = new Map(s.items.map((i) => [i.id, i]));
    const threadById = new Map(s.threadItems.map((i) => [i.id, i]));
    const lastLoaded = s.items.at(-1);
    const pendingById = new Map(s.pendingItems.map((i) => [i.id, i]));
    let changed = false;
    let threadChanged = false;
    let pendingChanged = false;
    let unseen = false;

    for (const inc of incoming) {
      // Every cached scope holding this row gets the newer copy, not only the
      // visible one (other tabs used to keep showing "running" for 30 s).
      patchCached(inc.id, (row) => (inc.updatedAt > (row.updatedAt ?? 0) ? { ...row, ...inc } : row));
      // The project conversation owns a separate copy of each row. Live
      // completion used to update only the right-hand asset feed, leaving the
      // chat copy permanently `running` until a full thread reload.
      const threadItem = threadById.get(inc.id);
      if (threadItem && inc.updatedAt > threadItem.updatedAt) {
        if (matchesThread(inc, s)) {
          threadById.set(inc.id, {
            ...threadItem,
            ...inc,
            queueNote: inc.status === "queued" ? threadItem.queueNote : undefined,
          });
        } else {
          threadById.delete(inc.id);
        }
        threadChanged = true;
      }

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

      unseen = true;
      if (!matchesScope(inc, scope)) continue;
      const inFlight = inc.status === "queued" || inc.status === "running";
      if ((!inFlight || scope.sort === "oldest") && lastLoaded && s.hasMoreHistory !== false && compareInScope(inc, lastLoaded, scope) > 0) continue;

      if (s.feedPinned) {
        byId.set(inc.id, inc);
        changed = true;
      } else if (!pendingById.has(inc.id) || pendingById.get(inc.id).updatedAt < inc.updatedAt) {
        pendingById.set(inc.id, inc);
        pendingChanged = true;
      }
    }

    const patch = {};
    if (changed) {
      const items = Array.from(byId.values()).sort((a, b) =>
        compareInScope(a, b, scope)
      );
      patch.items = items;
      writeCachedItems(scopeKey(scope), items);
    }
    if (threadChanged) patch.threadItems = Array.from(threadById.values());
    if (pendingChanged) patch.pendingItems = Array.from(pendingById.values());
    if (unseen) staleCached(scopeKey(scope));
    return patch;
  });
}

/** One poll of the live feed, then reschedule at a cadence that matches how
 *  much is actually happening. */
async function liveTick(
  set,
  get
) {
  if (!storeRuntime.liveRunning) return;
  // A hidden tab is throttled by the browser to roughly one timer per minute
  // anyway, and nobody is looking. Skip the request and let the
  // visibilitychange handler fire an immediate catch-up poll on return.
  if (typeof document !== "undefined" && document.hidden) {
    scheduleLive(set, get, LIVE_MS_IDLE);
    return;
  }
  const epoch = storeRuntime.epoch;
  let more = false;
  try {
    const res = await apiFetch(
      liveUpdatesUrl({ since: storeRuntime.liveSince, afterId: storeRuntime.liveAfterId }),
      { cache: "no-store" }
    );
    if (!res.ok) throw new Error(`updates ${res.status}`);
    const data = await res.json();
    if (!storeRuntime.liveRunning || epoch !== storeRuntime.epoch) return; // session disposed while in flight
    if (Array.isArray(data.items)) {
      mergeLiveItems(data.items, set);
    }
    // The server cursor pages through every change; client clocks never move it.
    const cursor = nextLiveCursor(data, { since: storeRuntime.liveSince, afterId: storeRuntime.liveAfterId });
    storeRuntime.liveSince = cursor.since;
    storeRuntime.liveAfterId = cursor.afterId;
    storeRuntime.liveFailures = 0;
    more = data.more === true;
  } catch {
    // Transient: back off instead of hammering a failing backend. 401 already redirects in apiFetch.
    if (epoch === storeRuntime.epoch) storeRuntime.liveFailures += 1;
  }
  const busy = hasRecentActiveWork([...get().items, ...get().threadItems, ...get().pendingItems]);
  scheduleLive(set, get, liveDelay({ more, busy, failures: storeRuntime.liveFailures }));
}

function scheduleLive(
  set,
  get,
  ms
) {
  if (!storeRuntime.liveRunning) return;
  if (storeRuntime.liveTimer) clearStoreTimeout(storeRuntime.liveTimer);
  storeRuntime.liveTimer = setStoreTimeout(() => liveTick(set, get), ms);
}

// ── composer draft + UI-state persistence ────────────────────────────────────
// The prompt is written on a short debounce (it changes per keystroke); the
// reference images are written only when they actually change (they can be
// multi-MB data URLs — serializing them per keystroke would jank typing);
// composer settings and panel/tab state are tiny and written on change.
const DRAFT_PROMPT_KEY = "veevee-draft-prompt-v1";
const DRAFT_REFS_KEY = "veevee-draft-refs-v1";
/** Past this, restoring the draft is not worth a multi-megabyte synchronous
 *  write that the ~5MB origin quota would likely reject anyway. Measured in
 *  characters of base64, which is close enough to bytes for a guard. */

const DRAFT_SETTINGS_KEY = "veevee-draft-settings-v1";

/** Restore the locally cached composer draft (prompt + reference images) and
 *  UI state (mode/model/settings, panel tab, active project/folder) once at
 *  mount, so a refresh doesn't reset the user's workspace. Settings restore
 *  always; prompt/refs only when the composer is empty. Every restored value
 *  is validated against the current catalog so a stale cache can't produce an
 *  invalid combination. */
export function restoreComposerDraft() {
  try {
    if (!useStore.getState().availableModelIds) {
      const cached = cachedAvailability();
      if (cached) useStore.setState({ availableModelIds: cached });
    }
    const rawSettings = localStorage.getItem(DRAFT_SETTINGS_KEY);
    if (rawSettings) {
      const d = JSON.parse(rawSettings);
      const patch = {};
      // "Refreshing keeps you on the same tab" covers Image/Video (mode) and
      // Board (view) — the composer settings below are mode-specific, so
      // mode is resolved first and view is independent of them.
      if (d.view === "studio" || d.view === "canvas") patch.view = d.view;
      const mode =
        d.mode === "image" || d.mode === "video" ? d.mode : undefined;
      if (mode) patch.mode = mode;
      const effMode = mode ?? useStore.getState().mode;
      // A retired model (Gemini Omni Flash) restores as its replacement, visibly, in the picker.
      // Availability is not consulted: the cached list only shapes the pickers until the session
      // answers, and only that answer (applyModelAvailability) moves a switched-off selection.
      const restoredModel = composerModel(d.model);
      if (isPickerModel(restoredModel, null, effMode)) {
        patch.model = restoredModel;
      }
      const effModel = patch.model ?? DEFAULTS[effMode].model;
      if (aspectRatiosForModel(effModel, effMode).includes(d.aspectRatio)) {
        patch.aspectRatio = d.aspectRatio;
      }
      if (resolutionsForModel(effModel, effMode).includes(d.resolution)) {
        patch.resolution = d.resolution;
      }
      const effDurationRange = durationRangeForModel(effModel);
      const durationValid = effDurationRange
        ? Number.isInteger(d.duration) &&
          d.duration >= effDurationRange.min &&
          d.duration <= effDurationRange.max
        : durationsForModel(effModel).includes(d.duration);
      if (durationValid) {
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
      if (typeof d.draftMode === "boolean") {
        patch.draftMode = supportsDraftMode(effModel) && d.draftMode;
      }
      if (["standard", "high"].includes(d.bitrateMode)) {
        patch.bitrateMode = supportsBitrateMode(effModel) ? d.bitrateMode : "high";
      }
      if (["project", "history", "favorites"].includes(d.rightTab)) {
        patch.rightTab = d.rightTab;
      }
      // rightPanelOpen is deliberately NOT restored — the assets drawer is a
      // transient overlay, not part of the durable workspace, and always
      // starts closed (see the drawer in page.tsx).
      // loadProjects validates the restored project id against the fetched
      // list, so a stale id self-heals to the default project.
      if (typeof d.activeProjectId === "string") patch.activeProjectId = d.activeProjectId;
      if (typeof d.activeFolderId === "string") patch.activeFolderId = d.activeFolderId;
      useStore.setState(patch);
    }
    if (useStore.getState().availabilityAnswered) reconcileAvailability(useStore.getState, useStore.setState);

    // Legacy caches were unscoped and could contain binary/signed references.
    localStorage.removeItem(DRAFT_PROMPT_KEY);
    localStorage.removeItem(DRAFT_REFS_KEY);
    void restoreScopedComposerDraft();
  } catch {
    /* corrupt or unavailable draft — start clean */
  }
}

let restoringDraft = false;
let draftRestoreEpoch = 0;

async function restoreScopedComposerDraft() {
  const epoch = ++draftRestoreEpoch;
  restoringDraft = true;
  const initial = useStore.getState(); const scope = snapshotScope(initial);
  if (!scope) { restoringDraft = false; return; }
  try {
    const draft = await loadComposerSnapshot(scope);
    const now = useStore.getState();
    if (!draft || scope !== snapshotScope(now) || now.prompt || now.referenceImages.length) return;
    // Missing refs must be reattached; keep positions so mentions never bind to another file.
    const refs = Array.isArray(draft.refs) ? draft.refs.slice(0, 50) : [];
    useStore.setState({ ...metadataToDraft(draft,newReferenceId),
      recentSubmission: draft.recent ? metadataToDraft(draft.recent,newReferenceId) : null,
      draftStorageWarning: refs.some(r => !r.mediaRef) ? "Some references need to be attached again." : null });
  } catch { /* storage denied/quota: visible draft still works */ }
  finally {
    if (epoch === draftRestoreEpoch) {
      restoringDraft = false;
      if (scope === snapshotScope(useStore.getState())) void saveComposerSnapshot(scope, composerMetadata(useStore.getState())).catch(() => {});
    }
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
let restoringLibrarySession = false;

if (typeof window !== "undefined") {
  useStore.subscribe((s, prev) => {
    const source = librarySourceKey(currentScope(s));
    const previousSource = librarySourceKey(currentScope(prev));
    const actor = s.currentUser?.id;
    const previousActor = prev.currentUser?.id;
    if (source !== previousSource || actor !== previousActor) {
      if (actor === previousActor) writeLibrarySession(previousActor, previousSource, prev);
      else { clearLibrarySession(previousActor); clearFeedCache(); }
      const restored = readLibrarySession(actor, source) || cleanLibraryQuery();
      if (actor !== previousActor && restored.libraryGroupByDate === undefined) restored.libraryGroupByDate = true;
      if (restored.librarySort === "starred" && s.rightTab !== "favorites") restored.librarySort = null;
      restoringLibrarySession = true;
      try { useStore.setState({ ...restored, ...CLEAR_SELECTION_PATCH }); }
      finally { restoringLibrarySession = false; }
      // Chat follows the open folder too, so a folder switch reloads it here.
      if (s.activeProjectId !== prev.activeProjectId || s.activeFolderId !== prev.activeFolderId) void useStore.getState().loadThread();
      if (s.activeProjectId !== prev.activeProjectId) void useStore.getState().loadAssets(s.activeProjectId);
      return;
    }
    if (s.libraryFilters !== prev.libraryFilters || s.search !== prev.search || s.librarySort !== prev.librarySort || s.libraryGroupByDate !== prev.libraryGroupByDate) {
      writeLibrarySession(actor, source, s);
    }
    const projectChanged = s.activeProjectId !== prev.activeProjectId;
    if (projectChanged || s.activeFolderId !== prev.activeFolderId) void s.loadThread();
    const searchChanged = s.search !== prev.search;
    const effectiveScopeChanged =
      projectChanged ||
      searchChanged ||
      s.rightTab !== prev.rightTab ||
      s.activeFolderId !== prev.activeFolderId ||
      s.libraryFilters !== prev.libraryFilters ||
      s.librarySort !== prev.librarySort ||
      (s.libraryDateNow !== prev.libraryDateNow && scopeKey(currentScope(s)) !== scopeKey(currentScope(prev)));

    if (effectiveScopeChanged && (s.selectedIds.length > 0 || s.focusedAssetId !== null || s.selectionAnchorId !== null)) {
      useStore.setState(CLEAR_SELECTION_PATCH);
    }

    const scopeChanged = effectiveScopeChanged || s.rightPanelOpen !== prev.rightPanelOpen;
    if (!scopeChanged) return;

    const key = scopeKey(currentScope(s));
    // Switching tabs between two scopes that resolve to the same query (a
    // project with no folder selected vs. the same, say) is not a refetch.
    if (key === storeRuntime.lastScopeKey && !projectChanged) return;
    storeRuntime.lastScopeKey = key;

    storeRuntime.scopeTimer = clearStoreTimeout(storeRuntime.scopeTimer);
    const run = () => {
      const st = useStore.getState();
      void st.loadFeed();
      void st.loadCounts();
      // Materials belong to the project; chat also follows folder changes above.
      if (projectChanged) {
        void st.loadAssets(st.activeProjectId);
      }
    };
    // Only typing waits; clicking a folder should feel instant.
    if (searchChanged && !projectChanged && !restoringLibrarySession) {
      storeRuntime.scopeTimer = setStoreTimeout(run, SEARCH_DEBOUNCE_MS);
    }
    else run();
  });

  useStore.subscribe((s, prev) => {
    if (snapshotScope(s) !== snapshotScope(prev)) {
      restoringDraft = true;
      useStore.setState({ prompt: "", referenceImages: [], referenceIds: [], referenceKinds: [], referenceLabels: [], referenceTags: [], referenceVideos: [], referenceAudios: [], recentSubmission: null });
      void restoreScopedComposerDraft();
    } else if (!restoringDraft && (s.prompt !== prev.prompt || s.referenceImages !== prev.referenceImages || s.referenceIds !== prev.referenceIds || s.referenceVideos !== prev.referenceVideos || s.referenceAudios !== prev.referenceAudios)) {
      storeRuntime.promptTimer = clearStoreTimeout(storeRuntime.promptTimer);
      const scope = snapshotScope(s);
      const persist = () => {
        if (scope === snapshotScope(useStore.getState())) void saveComposerSnapshot(scope, composerMetadata(useStore.getState())).catch(() => {
          useStore.setState({ draftStorageWarning: "Draft could not be saved on this device." });
        });
      };
      if (s.referenceImages !== prev.referenceImages || s.referenceIds !== prev.referenceIds || s.referenceVideos !== prev.referenceVideos || s.referenceAudios !== prev.referenceAudios) persist();
      else storeRuntime.promptTimer = setStoreTimeout(persist, 400);
    }
    if (
      s.view !== prev.view ||
      s.mode !== prev.mode ||
      s.model !== prev.model ||
      s.aspectRatio !== prev.aspectRatio ||
      s.resolution !== prev.resolution ||
      s.duration !== prev.duration ||
      s.batchCount !== prev.batchCount ||
      s.generateAudio !== prev.generateAudio ||
      s.draftMode !== prev.draftMode ||
      s.bitrateMode !== prev.bitrateMode ||
      s.rightTab !== prev.rightTab ||
      s.activeProjectId !== prev.activeProjectId ||
      s.activeFolderId !== prev.activeFolderId
    ) {
      try {
        localStorage.setItem(
          DRAFT_SETTINGS_KEY,
          JSON.stringify({
            view: s.view,
            mode: s.mode,
            model: s.model,
            aspectRatio: s.aspectRatio,
            resolution: s.resolution,
            duration: s.duration,
            batchCount: s.batchCount,
            generateAudio: s.generateAudio,
            draftMode: s.draftMode,
            bitrateMode: s.bitrateMode,
            audioDefault: true,
            rightTab: s.rightTab,
            activeProjectId: s.activeProjectId,
            activeFolderId: s.activeFolderId,
          })
        );
      } catch {}
    }
  });
  window.useStore = useStore;
}
