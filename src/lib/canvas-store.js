"use client";

import { create, } from "zustand";
import { clearPendingDraft, readPendingDraft, savePendingDraft, shouldUseKeepalive } from "./canvas-pending-draft";

import { apiFetch } from "./api";
import { emptyCanvasState, validateCanvasState } from "./canvas/serialization";
import { mergeCanvasStates, rebaseHistory, sameValue } from "./canvas/merge";
import {
  moveNodesBy,
  resizeNode,
  screenToWorld,
  nodeBounds,
  computeFrameMembership,

} from "./canvas/geometry";
import {
  bringToFront as zBringToFront,
  sendToBack as zSendToBack,
  bringForward as zBringForward,
  sendBackward as zSendBackward,
} from "./canvas/zorder";
import {
  commit as commitHistory,
  undo as undoHistory,
  redo as redoHistory,

} from "./canvas/history";

/**
 * The scoped canvas-board Zustand store (D-Store): holds the active board's
 * working graph (undo/redo history over CanvasState), selection, viewport
 * tool, and autosave status. Deliberately separate from `src/lib/store.ts`
 * so high-frequency drag/keystroke updates don't notify the whole app.
 */

 

// Reasonable, defensible bounds for AC #2's "min/max zoom bounds"; design.md
// doesn't pin exact numbers. Exported so CanvasToolbar/CanvasSurface can
// share the same clamp for scroll-zoom and the % readout.
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;

const DEBOUNCE_MS = 1500;
const MAX_RETRY_MS = 15000;
const GESTURE_IDLE_MS = 400;

// The store itself has no DOM/screen-size knowledge (Viewport is only
// {x,y,zoom}). CanvasSurface reports its real measured container size here
// via setViewportSize() (kept on its ResizeObserver), so zoomToFit() and the
// viewportCenterWorld() fallback are pixel-accurate rather than guessed. The
// 1600x900 default only matters before the first ResizeObserver callback.
let viewportPx = { w: 1600, h: 900 };

function redirectToLogin() {
  if (typeof window !== "undefined" && window.location.pathname !== "/login") {
    window.location.replace("/login");
  }
}

function clampZoom(z) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

function viewportCenterWorld(vp) {
  return screenToWorld({ x: viewportPx.w / 2, y: viewportPx.h / 2 }, vp);
}

/** Parses an "W:H" aspect ratio string (AspectRatio.value); null if unparseable. */
function parseAspectRatio(ar) {
  if (!ar) return null;
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ar.trim());
  if (!m) return null;
  const w = parseFloat(m[1]);
  const h = parseFloat(m[2]);
  if (!w || !h) return null;
  return w / h;
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

function normalizeCrop(crop) {
  return {
    x: clamp01(crop?.x ?? 0.5),
    y: clamp01(crop?.y ?? 0.5),
    zoom: Math.min(8, Math.max(1, crop?.zoom ?? 1)),
  };
}

function applyStylePatchToNode(n, patch) {
  const opacity = patch.opacity !== undefined ? clamp01(patch.opacity) : n.opacity;
  switch (n.type) {
    case "rect":
    case "ellipse":
    case "triangle":
    case "diamond":
      return {
        ...n,
        opacity,
        fill: patch.fill ?? n.fill,
        stroke: patch.stroke ?? n.stroke,
        strokeWidth: patch.strokeWidth ?? n.strokeWidth,
        cornerRadius:
          n.type === "rect" && patch.cornerRadius !== undefined
            ? patch.cornerRadius
            : n.cornerRadius,
      };
    case "text":
      return {
        ...n,
        opacity,
        text: patch.text ?? n.text,
        fontSize: patch.fontSize ?? n.fontSize,
        color: patch.color ?? n.color,
        align: patch.align ?? n.align,
      };
    case "sticky":
      return {
        ...n,
        opacity,
        text: patch.text ?? n.text,
        fill: patch.fill ?? n.fill,
        fontSize: patch.fontSize ?? n.fontSize,
        color: patch.color ?? n.color,
      };
    case "frame":
      return {
        ...n,
        opacity,
        fill: patch.fill ?? n.fill,
        stroke: patch.stroke ?? n.stroke,
        name: patch.name ?? n.name,
      };
    case "image":
      return { ...n, opacity };
  }
}

function applyStylePatchToConnector(c, patch) {
  return {
    ...c,
    stroke: patch.stroke ?? c.stroke,
    strokeWidth: patch.strokeWidth ?? c.strokeWidth,
    kind: patch.kind ?? c.kind,
    opacity: patch.opacity !== undefined ? clamp01(patch.opacity) : c.opacity,
  };
}

function shiftFreeEndpoint(ep, dx, dy) {
  if ("nodeId" in ep) return ep; // attached — follows the node automatically
  return { x: ep.x + dx, y: ep.y + dy };
}

/**
 * Shared clone-construction logic for `duplicateSelected`/`paste`/
 * `duplicateSelectionInPlace`: new ids, a group-id remap (each distinct
 * source `groupId` gets one new shared id, so duplicated grouped nodes stay
 * grouped with each other but not with the originals), a `parentId` remap
 * when the parent was ALSO cloned, and a uniform (dx,dy) offset.
 *
 * `keepUnmappedParent` preserves the two callers' pre-existing (and
 * different!) behavior when a clone's parent frame ISN'T itself in the
 * cloned set: `duplicateSelected`/`duplicateSelectionInPlace` keep the
 * clone as a child of the original (still-live) frame (`true`); `paste`
 * drops to no parent instead (`false`) — this is not a bug being fixed
 * here, just each action's existing behavior preserved verbatim.
 */
function buildClones(
  sourceNodes,
  ids,
  dx,
  dy,
  keepUnmappedParent
) {
  const idSet = new Set(ids);
  const idMap = new Map();
  for (const id of ids) idMap.set(id, crypto.randomUUID());
  const groupIdMap = new Map();
  const clones = [];
  for (const n of sourceNodes) {
    if (!idSet.has(n.id)) continue;
    const newId = idMap.get(n.id) ;
    let newGroupId = null;
    if (n.groupId) {
      if (!groupIdMap.has(n.groupId)) groupIdMap.set(n.groupId, crypto.randomUUID());
      newGroupId = groupIdMap.get(n.groupId) ;
    }
    const newParentId =
      n.parentId && idMap.has(n.parentId)
        ? (idMap.get(n.parentId) )
        : keepUnmappedParent
        ? n.parentId ?? null
        : null;
    clones.push({ ...n, id: newId, x: n.x + dx, y: n.y + dy, parentId: newParentId, groupId: newGroupId });
  }
  return { clones, idMap };
}

function pruneSelection(
  present,
  selection,
  selectedConnectorIds
) {
  const nodeIds = new Set(present.nodes.map((n) => n.id));
  const connIds = new Set(present.connectors.map((c) => c.id));
  return {
    selection: selection.filter((id) => nodeIds.has(id)),
    selectedConnectorIds: selectedConnectorIds.filter((id) => connIds.has(id)),
  };
}

// ---- gesture coalescing (module-level: one active gesture at a time) ----
let gestureBaseline = null;
let gestureEndTimer = null;

function finalizePendingGesture(set, get) {
  if (gestureEndTimer) {
    clearTimeout(gestureEndTimer);
    gestureEndTimer = null;
  }
  if (gestureBaseline) {
    const baseline = gestureBaseline;
    gestureBaseline = null;
    set({ history: commitHistory(baseline, get().history.present) });
  }
}

function scheduleGestureEnd(set, get) {
  if (gestureEndTimer) clearTimeout(gestureEndTimer);
  gestureEndTimer = setTimeout(() => {
    gestureEndTimer = null;
    finalizePendingGesture(set, get);
  }, GESTURE_IDLE_MS);
}

/** Applies `compute` to the live graph. Coalesced gestures (drag/resize)
 * freeze past/future at the pre-gesture baseline and only push ONE history
 * step once the gesture goes idle (design.md: "commit once on pointer-up",
 * approximated here via an idle timeout since the store gets no explicit
 * gesture-end signal). Non-coalesced mutations commit immediately. */
function mutateGraph(
  set,
  get,
  compute,
  opts
) {
  const state = get();
  const nextPresent = compute(state.history.present);
  if (opts?.coalesce) {
    if (!gestureBaseline) gestureBaseline = state.history;
    set({ history: { ...gestureBaseline, present: nextPresent } });
    scheduleGestureEnd(set, get);
  } else {
    finalizePendingGesture(set, get);
    set({ history: commitHistory(get().history, nextPresent) });
  }
  markDirty(set, get);
}

// ---- sync with other editors ----
// `serverVersion`/`serverState` are the board version this tab last synced
// and that version's graph: the base of the three-way merge when someone
// else saved in between (a 409 on save, or a newer version seen by polling).

/** The draft metadata that lets a restored draft merge instead of overwrite. */
function syncOf(state) {
  return { baseVersion: state.serverVersion, base: state.serverState };
}

/**
 * Merges another editor's newer `board` into the working graph and every
 * undo/redo snapshot, then adopts it as the sync base. Returns false for a
 * response that is not newer than what this tab already synced.
 */
function applyRemoteBoard(set, get, board) {
  const state = get();
  const version = board?.version;
  if (typeof version !== "number" || (state.serverVersion !== null && version <= state.serverVersion)) return false;
  const remote = validateCanvasState(board.data);
  const keepLocal = new Set([state.editingTextId, state.croppingImageId].filter(Boolean));
  const history = rebaseHistory(state.history, state.serverState, remote, { keepLocal });
  if (gestureBaseline) gestureBaseline = rebaseHistory(gestureBaseline, state.serverState, remote);
  set({
    history,
    serverVersion: version,
    serverState: remote,
    ...pruneSelection(history.present, state.selection, state.selectedConnectorIds),
  });
  return true;
}

// ---- autosave (module-level debounce/backoff/in-flight guard) ----
let debounceTimer = null;
let retryBackoffMs = DEBOUNCE_MS;
let saveInFlight = null;

function clearDebounceTimer() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

function scheduleFlush(get, delay) {
  clearDebounceTimer();
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void get().flushSave();
  }, delay);
}

function markDirty(set, get) {
  set({ saveStatus: "dirty" });
  scheduleFlush(get, DEBOUNCE_MS);
}

async function flushSaveImpl(
  set,
  get,
  opts
) {
  if (saveInFlight) return saveInFlight;
  const state = get();
  if (!state.boardId) return;
  if (state.saveStatus !== "dirty" && state.saveStatus !== "error") return;

  clearDebounceTimer();

  saveInFlight = (async () => {
    const boardId = state.boardId ;
    const sentPresent = state.history.present;
    const baseVersion = state.serverVersion;
    // Without a known version (a backend that predates versions) the save stays unconditional.
    const body = JSON.stringify(baseVersion === null ? { data: sentPresent } : { data: sentPresent, baseVersion });
    // Durable until the server acknowledges exactly this content.
    savePendingDraft(boardId, sentPresent, Date.now(), syncOf(state));
    set({ saveStatus: "saving" });
    try {
      const res = await apiFetch(`/api/canvas-boards/${boardId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body,
        // Browsers reject oversized keepalive bodies outright; large boards use
        // a normal request and rely on the pending draft if the page unloads.
        keepalive: Boolean(opts?.keepalive) && shouldUseKeepalive(body),
      });
      if (res.status === 401) {
        redirectToLogin();
        set({ saveStatus: "error" });
        return;
      }
      if (res.status === 409) {
        // Someone else saved first: merge their graph under this tab's edits and save the result.
        const { board } = await res.json();
        if (get().boardId !== boardId || !applyRemoteBoard(set, get, board)) {
          throw new Error("save conflict without a newer board");
        }
        retryBackoffMs = DEBOUNCE_MS;
        set({ saveStatus: "dirty" });
        scheduleFlush(get, 0);
        return;
      }
      if (!res.ok) throw new Error(`save failed: ${res.status}`);
      const j = await res.json();
      clearPendingDraft(boardId, sentPresent);
      retryBackoffMs = DEBOUNCE_MS;
      if (get().boardId === boardId && typeof j.version === "number") {
        // What the server now holds, normalized the same way it normalizes saves.
        set({ serverVersion: j.version, serverState: validateCanvasState(sentPresent) });
      }
      // Only mark "saved" if nothing changed while the request was in
      // flight — an edit mid-flight already flipped status back to "dirty"
      // and scheduled its own retry timer; overwriting it here would make
      // that timer's guard wrongly bail and silently drop the edit.
      if (get().history.present === sentPresent) {
        set({ saveStatus: "saved" });
      }
    } catch {
      set({ saveStatus: "error" });
      retryBackoffMs = Math.min(MAX_RETRY_MS, retryBackoffMs * 2);
      scheduleFlush(get, retryBackoffMs);
    }
  })();

  try {
    await saveInFlight;
  } finally {
    saveInFlight = null;
  }
}

/**
 * Un-acknowledged local edits from an earlier visit, ready to re-save, or
 * null when there are none. A draft whose base version is older than the
 * server's merges with what other people saved meanwhile; a draft without its
 * base graph merges as a union so nobody's nodes are lost; a draft from
 * before versions keeps the old rule (it wins only if newer than the server).
 */
function restoredDraft(pending, server, serverVersion, serverUpdatedAt) {
  if (!pending) return null;
  const draft = validateCanvasState(pending.data);
  let restored = null;
  if (typeof pending.baseVersion === "number" && serverVersion !== null) {
    restored = pending.baseVersion === serverVersion
      ? draft
      : mergeCanvasStates(pending.base ? validateCanvasState(pending.base) : emptyCanvasState(), draft, server);
  } else if (pending.at > serverUpdatedAt) {
    restored = draft;
  }
  return restored && !sameValue(restored, server) ? restored : null;
}

// Guards against out-of-order GET responses when boards are switched in
// quick succession: only the most recently *started* load is allowed to
// write its result into the store.
let loadGeneration = 0;

async function loadBoardImpl(set, get, id) {
  const myGeneration = ++loadGeneration;
  await get().flushSave();
  if (myGeneration !== loadGeneration) return; // superseded while flushing

  // A failed flush keeps its pending draft; reset() must not be the only copy.
  get().persistPendingDraft();
  get().reset();
  set({ boardId: id, loaded: false });

  let res;
  try {
    res = await apiFetch(`/api/canvas-boards/${id}`, { cache: "no-store" });
  } catch (err) {
    if (myGeneration === loadGeneration) set({ boardId: null, loaded: true });
    throw err;
  }
  if (myGeneration !== loadGeneration) return; // superseded while fetching

  if (res.status === 401) {
    redirectToLogin();
    throw new Error("UNAUTHENTICATED");
  }
  if (res.status === 404) {
    if (myGeneration === loadGeneration) set({ boardId: null, boardName: "", loaded: true });
    throw new Error("NOT_FOUND");
  }
  if (!res.ok) {
    if (myGeneration === loadGeneration) set({ boardId: null, loaded: true });
    throw new Error(`load failed: ${res.status}`);
  }

  const board = await res.json();
  const data = validateCanvasState(board.data);
  if (myGeneration !== loadGeneration) return; // superseded while parsing

  const serverVersion = typeof board.version === "number" ? board.version : null;
  const restored = restoredDraft(readPendingDraft(board.id), data, serverVersion, Number(board.updatedAt) || 0);
  if (!restored) clearPendingDraft(board.id);

  set({
    boardId: board.id,
    boardName: board.name,
    history: { past: [], present: restored || data, future: [] },
    serverVersion,
    serverState: data,
    selection: [],
    selectedConnectorIds: [],
    editingTextId: null,
    croppingImageId: null,
    cropDraft: null,
    saveStatus: restored ? "dirty" : "idle",
    loaded: true,
  });
  if (restored) scheduleFlush(get, 0);
}

let pollInFlight = false;

/**
 * Asks for the board's version (two integers, never the graph) and, only when
 * someone else saved, fetches the board and merges it. A save in flight
 * takes precedence: its 409 merges, or the next poll sees the newer version.
 * Resolves true when another person's change was merged.
 */
async function pollRemoteImpl(set, get) {
  const { boardId, loaded, serverVersion } = get();
  if (!boardId || !loaded || serverVersion === null || pollInFlight) return false;
  const generation = loadGeneration;
  const current = () => generation === loadGeneration && get().boardId === boardId;
  pollInFlight = true;
  try {
    const res = await apiFetch(`/api/canvas-boards/${boardId}/version`, { cache: "no-store" });
    if (!res.ok) return false;
    const { version } = await res.json();
    if (!current() || typeof version !== "number" || version <= get().serverVersion) return false;
    const full = await apiFetch(`/api/canvas-boards/${boardId}`, { cache: "no-store" });
    if (!full.ok) return false;
    const board = await full.json();
    return current() && !saveInFlight && applyRemoteBoard(set, get, board);
  } catch {
    // Offline or a transient failure: the next poll tries again.
    return false;
  } finally {
    pollInFlight = false;
  }
}

// Clipboard (spec: "copy/paste within a board and across boards"). Kept as
// a module variable, NOT store state, so it survives loadBoard()/reset().
let clipboard = [];

export const useCanvasStore = create((set, get) => ({
  boardId: null,
  boardName: "",
  loaded: false,
  history: { past: [], present: emptyCanvasState(), future: [] },
  serverVersion: null,
  serverState: emptyCanvasState(),
  selection: [],
  selectedConnectorIds: [],
  tool: "select",
  editingTextId: null,
  saveStatus: "idle",
  croppingImageId: null,
  cropDraft: null,

  loadBoard: (id) => loadBoardImpl(set, get, id),

  /** One poll for other people's saves; see `useBoardPolling` for the cadence. */
  pollRemote: () => pollRemoteImpl(set, get),

  reset: () => {
    clearDebounceTimer();
    if (gestureEndTimer) {
      clearTimeout(gestureEndTimer);
      gestureEndTimer = null;
    }
    gestureBaseline = null;
    retryBackoffMs = DEBOUNCE_MS;
    set({
      boardId: null,
      boardName: "",
      loaded: false,
      history: { past: [], present: emptyCanvasState(), future: [] },
      serverVersion: null,
      serverState: emptyCanvasState(),
      selection: [],
      selectedConnectorIds: [],
      tool: "select",
      editingTextId: null,
      saveStatus: "idle",
      croppingImageId: null,
      cropDraft: null,
    });
  },

  flushSave: (opts) => flushSaveImpl(set, get, opts),

  /** Keep a durable copy of edits that are not yet acknowledged by the server. */
  persistPendingDraft: () => {
    const state = get();
    if (!state.boardId) return false;
    if (state.saveStatus !== "dirty" && state.saveStatus !== "error" && state.saveStatus !== "saving") return false;
    return savePendingDraft(state.boardId, state.history.present, Date.now(), syncOf(state));
  },

  setViewport: (vp) => {
    const state = get();
    set({ history: { ...state.history, present: { ...state.history.present, viewport: vp } } });
    markDirty(set, get);
  },

  zoomToFit: () => {
    const { nodes } = get().history.present;
    if (!nodes.length) {
      get().setViewport({ x: 0, y: 0, zoom: 1 });
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of nodes) {
      const b = nodeBounds(n);
      minX = Math.min(minX, b.x);
      minY = Math.min(minY, b.y);
      maxX = Math.max(maxX, b.x + b.w);
      maxY = Math.max(maxY, b.y + b.h);
    }
    const PAD = 80;
    const boundsW = Math.max(1, maxX - minX + PAD * 2);
    const boundsH = Math.max(1, maxY - minY + PAD * 2);
    const zoom = clampZoom(
      Math.min(viewportPx.w / boundsW, viewportPx.h / boundsH)
    );
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    get().setViewport({
      x: cx - viewportPx.w / 2 / zoom,
      y: cy - viewportPx.h / 2 / zoom,
      zoom,
    });
  },

  setViewportSize: (w, h) => {
    if (w > 0 && h > 0) viewportPx = { w, h };
  },

  setTool: (t) => set({ tool: t }),

  addNode: (node) => {
    mutateGraph(set, get, (present) => ({ ...present, nodes: [...present.nodes, node] }));
    set({ selection: [node.id], selectedConnectorIds: [] });
  },

  addImageBatch: (images, worldPoint) => {
    if (!images.length) return;
    const vp = get().history.present.viewport;
    const target = worldPoint ?? viewportCenterWorld(vp);
    const OFFSET = 24;
    const nodes = images.map((image, index) => {
      const ratio = image.naturalW > 0 && image.naturalH > 0
        ? image.naturalW / image.naturalH
        : parseAspectRatio(image.aspectRatio) ?? 1;
      const w = ratio >= 1 ? 320 : 320 * ratio;
      const h = ratio >= 1 ? 320 / ratio : 320;
      return {
        id: crypto.randomUUID(), type: "image",
        x: target.x - w / 2 + index * OFFSET,
        y: target.y - h / 2 + index * OFFSET,
        w, h, src: image.url, alt: image.alt ?? "",
        naturalW: image.naturalW, naturalH: image.naturalH,
        aspectLocked: false, parentId: null, groupId: null,
      };
    });
    mutateGraph(set, get, (present) => ({ ...present, nodes: [...present.nodes, ...nodes] }));
    set({ selection: nodes.map((node) => node.id), selectedConnectorIds: [] });
  },

  addImageFromAsset: (a, worldPoint) => {
    const vp = get().history.present.viewport;
    const target = worldPoint ?? viewportCenterWorld(vp);
    const LONG_EDGE = 320;
    const ratio = parseAspectRatio(a.aspectRatio) ?? 1;
    const w = ratio >= 1 ? LONG_EDGE : LONG_EDGE * ratio;
    const h = ratio >= 1 ? LONG_EDGE / ratio : LONG_EDGE;
    const node = {
      id: crypto.randomUUID(),
      type: "image",
      x: target.x - w / 2,
      y: target.y - h / 2,
      w,
      h,
      src: a.url,
      aspectLocked: false,
      parentId: null,
      groupId: null,
    };
    get().addNode(node);
  },

  updateSelectedStyle: (patch) => {
    const { selection, selectedConnectorIds } = get();
    if (!selection.length && !selectedConnectorIds.length) return;
    mutateGraph(
      set,
      get,
      (present) => ({
        ...present,
        nodes: present.nodes.map((n) =>
          selection.includes(n.id) ? applyStylePatchToNode(n, patch) : n
        ),
        connectors: present.connectors.map((c) =>
          selectedConnectorIds.includes(c.id) ? applyStylePatchToConnector(c, patch) : c
        ),
      }),
      { coalesce: true }
    );
  },

  /** Writes an inline text/label edit to its node by id, as one undo step. */
  commitText: (id, text) => {
    const node = get().history.present.nodes.find((item) => item.id === id);
    const patch = node?.type === "frame" ? { name: text } : { text };
    if (node && !sameValue(applyStylePatchToNode(node, patch), node)) {
      mutateGraph(set, get, (present) => ({
        ...present,
        nodes: present.nodes.map((item) => (item.id === id ? applyStylePatchToNode(item, patch) : item)),
      }));
    }
    if (get().editingTextId === id) set({ editingTextId: null });
  },

  moveSelectionBy: (dx, dy) => {
    const { selection, selectedConnectorIds } = get();
    if (!selection.length && !selectedConnectorIds.length) return;
    mutateGraph(
      set,
      get,
      (present) => {
        let next = moveNodesBy(present, selection, dx, dy);
        // Drag-end reparenting: a dragged (non-frame) node adopts whichever
        // frame its center now sits inside, or is released if dragged out.
        const frames = next.nodes.filter((n) => n.type === "frame");
        next = {
          ...next,
          nodes: next.nodes.map((n) => {
            if (n.type === "frame" || !selection.includes(n.id)) return n;
            const newParentId = computeFrameMembership(n, frames);
            return newParentId !== (n.parentId ?? null) ? { ...n, parentId: newParentId } : n;
          }),
        };
        if (selectedConnectorIds.length) {
          next = {
            ...next,
            connectors: next.connectors.map((c) =>
              selectedConnectorIds.includes(c.id)
                ? {
                    ...c,
                    from: shiftFreeEndpoint(c.from, dx, dy),
                    to: shiftFreeEndpoint(c.to, dx, dy),
                  }
                : c
            ),
          };
        }
        return next;
      },
      { coalesce: true }
    );
  },

  keepGestureAlive: () => {
    if (gestureBaseline) scheduleGestureEnd(set, get);
  },

  resizeSelected: (handle, dx, dy, keepAspect) => {
    const { selection } = get();
    if (!selection.length) return;
    mutateGraph(
      set,
      get,
      (present) => ({
        ...present,
        nodes: present.nodes.map((n) =>
          selection.includes(n.id) ? resizeNode(n, handle, dx, dy, keepAspect) : n
        ),
      }),
      { coalesce: true }
    );
  },

  deleteSelected: () => {
    const { selection, selectedConnectorIds } = get();
    if (!selection.length && !selectedConnectorIds.length) return;
    const deleteIds = new Set(selection);
    const connDeleteIds = new Set(selectedConnectorIds);
    mutateGraph(set, get, (present) => {
      const nodes = present.nodes
        .filter((n) => !deleteIds.has(n.id))
        .map((n) => (n.parentId && deleteIds.has(n.parentId) ? { ...n, parentId: null } : n));
      // Deleting a node also drops connectors referencing its id.
      const connectors = present.connectors.filter((c) => {
        if (connDeleteIds.has(c.id)) return false;
        if ("nodeId" in c.from && deleteIds.has(c.from.nodeId)) return false;
        if ("nodeId" in c.to && deleteIds.has(c.to.nodeId)) return false;
        return true;
      });
      return { ...present, nodes, connectors };
    });
    set({ selection: [], selectedConnectorIds: [] });
  },

  duplicateSelected: () => {
    const { selection } = get();
    if (!selection.length) return;
    let idMap = new Map();
    mutateGraph(set, get, (present) => {
      const built = buildClones(present.nodes, selection, 20, 20, true);
      idMap = built.idMap;
      return { ...present, nodes: [...present.nodes, ...built.clones] };
    });
    set({ selection: Array.from(idMap.values()), selectedConnectorIds: [] });
  },

  duplicateSelectionInPlace: () => {
    const { selection } = get();
    if (!selection.length) return;
    let idMap = new Map();
    mutateGraph(
      set,
      get,
      (present) => {
        // Zero offset — duplicates land exactly on the originals (alt-drag
        // then drags the duplicates; the originals are left untouched).
        const built = buildClones(present.nodes, selection, 0, 0, true);
        idMap = built.idMap;
        return { ...present, nodes: [...present.nodes, ...built.clones] };
      },
      { coalesce: true }
    );
    set({ selection: Array.from(idMap.values()), selectedConnectorIds: [] });
  },

  group: () => {
    const { selection } = get();
    if (selection.length < 2) return;
    const groupId = crypto.randomUUID();
    mutateGraph(set, get, (present) => ({
      ...present,
      nodes: present.nodes.map((n) => (selection.includes(n.id) ? { ...n, groupId } : n)),
    }));
  },

  ungroup: () => {
    const { selection } = get();
    if (!selection.length) return;
    mutateGraph(set, get, (present) => ({
      ...present,
      nodes: present.nodes.map((n) => (selection.includes(n.id) ? { ...n, groupId: null } : n)),
    }));
  },

  bringToFront: () => {
    const { selection } = get();
    if (!selection.length) return;
    mutateGraph(set, get, (present) => ({ ...present, nodes: zBringToFront(present.nodes, selection) }));
  },
  sendToBack: () => {
    const { selection } = get();
    if (!selection.length) return;
    mutateGraph(set, get, (present) => ({ ...present, nodes: zSendToBack(present.nodes, selection) }));
  },
  bringForward: () => {
    const { selection } = get();
    if (!selection.length) return;
    mutateGraph(set, get, (present) => ({ ...present, nodes: zBringForward(present.nodes, selection) }));
  },
  sendBackward: () => {
    const { selection } = get();
    if (!selection.length) return;
    mutateGraph(set, get, (present) => ({ ...present, nodes: zSendBackward(present.nodes, selection) }));
  },

  addConnector: (from, to, kind) => {
    const connector = {
      id: crypto.randomUUID(),
      from,
      to,
      kind,
      stroke: "rgba(255,255,255,0.7)",
      strokeWidth: 2,
    };
    mutateGraph(set, get, (present) => ({
      ...present,
      connectors: [...present.connectors, connector],
    }));
    set({ selection: [], selectedConnectorIds: [connector.id] });
  },

  updateConnectorEndpoint: (connectorId, end, endpoint) => {
    const exists = get().history.present.connectors.some((c) => c.id === connectorId);
    if (!exists) return; // no-op for a missing connector id
    mutateGraph(
      set,
      get,
      (present) => ({
        ...present,
        connectors: present.connectors.map((c) =>
          c.id === connectorId ? { ...c, [end]: endpoint } : c
        ),
      }),
      { coalesce: true }
    );
  },

  copy: () => {
    const { selection, history } = get();
    if (!selection.length) return;
    const selSet = new Set(selection);
    clipboard = history.present.nodes.filter((n) => selSet.has(n.id)).map((n) => ({ ...n }));
  },

  cut: () => {
    const { selection, history } = get();
    if (!selection.length) return;
    const selected = new Set(selection);
    clipboard = history.present.nodes.filter((node) => selected.has(node.id)).map((node) => ({ ...node }));
    get().deleteSelected();
  },

  beginCrop: (id) => {
    const node = get().history.present.nodes.find((item) => item.id === id && item.type === "image");
    if (node) set({ croppingImageId: id, cropDraft: normalizeCrop(node.crop) });
  },
  updateCropDraft: (patch) => {
    const draft = get().cropDraft;
    if (draft) set({ cropDraft: normalizeCrop({ ...draft, ...patch }) });
  },
  resetCropDraft: () => set({ cropDraft: { x: 0.5, y: 0.5, zoom: 1 } }),
  cancelCrop: () => set({ croppingImageId: null, cropDraft: null }),
  applyCrop: () => {
    const { croppingImageId, cropDraft } = get();
    if (!croppingImageId || !cropDraft) return;
    const crop = normalizeCrop(cropDraft);
    mutateGraph(set, get, (present) => ({
      ...present,
      nodes: present.nodes.map((node) => node.id === croppingImageId ? { ...node, crop } : node),
    }));
    set({ croppingImageId: null, cropDraft: null });
  },

  paste: () => {
    if (!clipboard.length) return;
    let idMap = new Map();
    mutateGraph(set, get, (present) => {
      // Cloned from the clipboard SNAPSHOT (taken at copy()-time), not from
      // the live present — edits made after copying, or the original being
      // deleted, don't affect what gets pasted, matching pre-refactor
      // behavior. `keepUnmappedParent: false` also matches paste's existing
      // behavior of dropping to no parent when the parent wasn't copied too.
      const built = buildClones(
        clipboard,
        clipboard.map((n) => n.id),
        20,
        20,
        false
      );
      idMap = built.idMap;
      return { ...present, nodes: [...present.nodes, ...built.clones] };
    });
    set({ selection: Array.from(idMap.values()), selectedConnectorIds: [] });
  },

  undo: () => {
    finalizePendingGesture(set, get);
    const history = undoHistory(get().history);
    const { selection, selectedConnectorIds } = get();
    set({ history, ...pruneSelection(history.present, selection, selectedConnectorIds) });
    markDirty(set, get);
  },

  redo: () => {
    finalizePendingGesture(set, get);
    const history = redoHistory(get().history);
    const { selection, selectedConnectorIds } = get();
    set({ history, ...pruneSelection(history.present, selection, selectedConnectorIds) });
    markDirty(set, get);
  },

  setSelection: (ids) => {
    const { editingTextId } = get();
    set({
      selection: ids,
      selectedConnectorIds: [],
      editingTextId: editingTextId && ids.includes(editingTextId) ? editingTextId : null,
    });
  },

  toggleSelect: (id) => {
    const { history, selection, selectedConnectorIds } = get();
    const isConnector = history.present.connectors.some((c) => c.id === id);
    if (isConnector) {
      set({
        selectedConnectorIds: selectedConnectorIds.includes(id)
          ? selectedConnectorIds.filter((x) => x !== id)
          : [...selectedConnectorIds, id],
      });
    } else {
      set({
        selection: selection.includes(id)
          ? selection.filter((x) => x !== id)
          : [...selection, id],
      });
    }
  },

  selectAll: () => {
    const { present } = get().history;
    set({
      selection: present.nodes.map((n) => n.id),
      selectedConnectorIds: present.connectors.map((c) => c.id),
    });
  },

  clearSelection: () => set({ selection: [], selectedConnectorIds: [], editingTextId: null }),

  setEditingTextId: (id) => set({ editingTextId: id }),
}));

// Re-exported for consumers that need to build frame-membership candidates
// (StyleInspector/CanvasSurface) without re-deriving the FrameNode filter.
export function frameNodesOf(state) {
  return state.nodes.filter((n) => n.type === "frame");
}

/** Reads the module-level `clipboard` var directly — NOT reactive (not
 *  store state), matching how `clipboard` itself is intentionally kept
 *  outside the Zustand store so it survives `loadBoard()`/`reset()`. Used
 *  by `CanvasContextMenu`'s `Paste` row / `selectionActions`' `canPaste`. */
export function hasClipboard() {
  return clipboard.length > 0;
}
