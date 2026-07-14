"use client";

import { create, type StoreApi } from "zustand";
import type {
  CanvasBoard,
  CanvasNode,
  CanvasState,
  Connector,
  Endpoint,
  FrameNode,
  ImageNode,
  Viewport,
} from "./canvas/types";
import { emptyCanvasState, validateCanvasState } from "./canvas/serialization";
import {
  moveNodesBy,
  resizeNode,
  screenToWorld,
  nodeBounds,
  computeFrameMembership,
  type Point,
  type ResizeHandle,
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
  type History,
} from "./canvas/history";

/**
 * The scoped canvas-board Zustand store (D-Store): holds the active board's
 * working graph (undo/redo history over CanvasState), selection, viewport
 * tool, and autosave status. Deliberately separate from `src/lib/store.ts`
 * so high-frequency drag/keystroke updates don't notify the whole app.
 */

export type CanvasTool =
  | "select"
  | "hand"
  | "rect"
  | "ellipse"
  | "triangle"
  | "diamond"
  | "text"
  | "sticky"
  | "frame"
  | "connector";

export type SaveStatus = "idle" | "dirty" | "saving" | "saved" | "error";

/** Style-and-content-patchable fields across node types (and, where
 * applicable, connectors) — used by StyleInspector's/CanvasSurface's
 * `updateSelectedStyle`. `text` (text/sticky content commit after inline
 * editing) and `kind` (connector line/arrow toggle) aren't "style" in the
 * strict sense but are routed through this same single patch call since
 * design.md doesn't carve out a separate content/connector-restyle action. */
export interface NodeStyleProps {
  fill: string;
  stroke: string;
  strokeWidth: number;
  opacity: number;
  cornerRadius: number;
  fontSize: number;
  color: string;
  align: "left" | "center" | "right";
  name: string; // frame label
  text: string; // text/sticky content
  kind: Connector["kind"]; // connector line/arrow
}

export interface CanvasStore {
  boardId: string | null;
  boardName: string;
  loaded: boolean;
  history: History<CanvasState>; // .present is the live graph
  selection: string[]; // node ids
  selectedConnectorIds: string[];
  tool: CanvasTool;
  editingTextId: string | null;
  saveStatus: SaveStatus;

  // lifecycle
  loadBoard: (id: string) => Promise<void>;
  reset: () => void;
  flushSave: (opts?: { keepalive?: boolean }) => Promise<void>;

  // viewport / tool
  setViewport: (vp: Viewport) => void; // NOT history-committed
  zoomToFit: () => void;
  /** CanvasSurface reports its real measured container size so zoomToFit()/
   * viewportCenterWorld() are pixel-accurate instead of a guessed default. */
  setViewportSize: (w: number, h: number) => void;
  setTool: (t: CanvasTool) => void;

  // graph mutations (each: commit history + markDirty)
  addNode: (node: CanvasNode) => void;
  addImageFromAsset: (
    a: { url: string; aspectRatio?: string },
    worldPoint?: Point
  ) => void;
  updateSelectedStyle: (patch: Partial<NodeStyleProps>) => void;
  moveSelectionBy: (dx: number, dy: number) => void; // gesture-end commit (coalesced)
  resizeSelected: (
    handle: ResizeHandle,
    dx: number,
    dy: number,
    keepAspect: boolean
  ) => void;
  deleteSelected: () => void;
  duplicateSelected: () => void;
  group: () => void;
  ungroup: () => void;
  bringToFront: () => void;
  sendToBack: () => void;
  bringForward: () => void;
  sendBackward: () => void;
  addConnector: (from: Endpoint, to: Endpoint, kind: Connector["kind"]) => void;
  copy: () => void;
  paste: () => void;
  undo: () => void;
  redo: () => void;
  setSelection: (ids: string[]) => void;
  toggleSelect: (id: string) => void;
  selectAll: () => void;
  clearSelection: () => void;

  // Not in design.md's documented action list, but required for the
  // `editingTextId` field (double-click-to-edit text/sticky) to be usable
  // by TextNode.tsx/StickyNode.tsx — see final report "deviations".
  setEditingTextId: (id: string | null) => void;
}

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

type SetFn = StoreApi<CanvasStore>["setState"];
type GetFn = StoreApi<CanvasStore>["getState"];

function redirectToLogin() {
  if (typeof window !== "undefined" && window.location.pathname !== "/login") {
    window.location.replace("/login");
  }
}

function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

function viewportCenterWorld(vp: Viewport): Point {
  return screenToWorld({ x: viewportPx.w / 2, y: viewportPx.h / 2 }, vp);
}

/** Parses an "W:H" aspect ratio string (AspectRatio.value); null if unparseable. */
function parseAspectRatio(ar?: string): number | null {
  if (!ar) return null;
  const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(ar.trim());
  if (!m) return null;
  const w = parseFloat(m[1]);
  const h = parseFloat(m[2]);
  if (!w || !h) return null;
  return w / h;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function applyStylePatchToNode(n: CanvasNode, patch: Partial<NodeStyleProps>): CanvasNode {
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

function applyStylePatchToConnector(c: Connector, patch: Partial<NodeStyleProps>): Connector {
  return {
    ...c,
    stroke: patch.stroke ?? c.stroke,
    strokeWidth: patch.strokeWidth ?? c.strokeWidth,
    kind: patch.kind ?? c.kind,
    opacity: patch.opacity !== undefined ? clamp01(patch.opacity) : c.opacity,
  };
}

function shiftFreeEndpoint(ep: Endpoint, dx: number, dy: number): Endpoint {
  if ("nodeId" in ep) return ep; // attached — follows the node automatically
  return { x: ep.x + dx, y: ep.y + dy };
}

function pruneSelection(
  present: CanvasState,
  selection: string[],
  selectedConnectorIds: string[]
): { selection: string[]; selectedConnectorIds: string[] } {
  const nodeIds = new Set(present.nodes.map((n) => n.id));
  const connIds = new Set(present.connectors.map((c) => c.id));
  return {
    selection: selection.filter((id) => nodeIds.has(id)),
    selectedConnectorIds: selectedConnectorIds.filter((id) => connIds.has(id)),
  };
}

// ---- gesture coalescing (module-level: one active gesture at a time) ----
let gestureBaseline: History<CanvasState> | null = null;
let gestureEndTimer: ReturnType<typeof setTimeout> | null = null;

function finalizePendingGesture(set: SetFn, get: GetFn) {
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

function scheduleGestureEnd(set: SetFn, get: GetFn) {
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
  set: SetFn,
  get: GetFn,
  compute: (present: CanvasState) => CanvasState,
  opts?: { coalesce?: boolean }
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

// ---- autosave (module-level debounce/backoff/in-flight guard) ----
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let retryBackoffMs = DEBOUNCE_MS;
let saveInFlight: Promise<void> | null = null;

function clearDebounceTimer() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

function scheduleFlush(get: GetFn, delay: number) {
  clearDebounceTimer();
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void get().flushSave();
  }, delay);
}

function markDirty(set: SetFn, get: GetFn) {
  set({ saveStatus: "dirty" });
  scheduleFlush(get, DEBOUNCE_MS);
}

async function flushSaveImpl(
  set: SetFn,
  get: GetFn,
  opts?: { keepalive?: boolean }
): Promise<void> {
  if (saveInFlight) return saveInFlight;
  const state = get();
  if (!state.boardId) return;
  if (state.saveStatus !== "dirty" && state.saveStatus !== "error") return;

  clearDebounceTimer();

  saveInFlight = (async () => {
    const boardId = state.boardId as string;
    const sentPresent = state.history.present;
    set({ saveStatus: "saving" });
    try {
      const res = await fetch(`/api/canvas-boards/${boardId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: sentPresent }),
        keepalive: opts?.keepalive,
      });
      if (res.status === 401) {
        redirectToLogin();
        set({ saveStatus: "error" });
        return;
      }
      if (!res.ok) throw new Error(`save failed: ${res.status}`);
      const j = await res.json();
      retryBackoffMs = DEBOUNCE_MS;
      // Only mark "saved" if nothing changed while the request was in
      // flight — an edit mid-flight already flipped status back to "dirty"
      // and scheduled its own retry timer; overwriting it here would make
      // that timer's guard wrongly bail and silently drop the edit.
      if (get().history.present === sentPresent) {
        set({ saveStatus: "saved" });
      }
      // Keep boardName untouched — only updatedAt bookkeeping matters here.
      void j.updatedAt;
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

// Guards against out-of-order GET responses when boards are switched in
// quick succession: only the most recently *started* load is allowed to
// write its result into the store.
let loadGeneration = 0;

async function loadBoardImpl(set: SetFn, get: GetFn, id: string): Promise<void> {
  const myGeneration = ++loadGeneration;
  await get().flushSave();
  if (myGeneration !== loadGeneration) return; // superseded while flushing

  get().reset();
  set({ boardId: id, loaded: false });

  let res: Response;
  try {
    res = await fetch(`/api/canvas-boards/${id}`, { cache: "no-store" });
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

  const board: CanvasBoard = await res.json();
  const data = validateCanvasState(board.data);
  if (myGeneration !== loadGeneration) return; // superseded while parsing

  set({
    boardId: board.id,
    boardName: board.name,
    history: { past: [], present: data, future: [] },
    selection: [],
    selectedConnectorIds: [],
    editingTextId: null,
    saveStatus: "idle",
    loaded: true,
  });
}

// Clipboard (spec: "copy/paste within a board and across boards"). Kept as
// a module variable, NOT store state, so it survives loadBoard()/reset().
let clipboard: CanvasNode[] = [];

export const useCanvasStore = create<CanvasStore>((set, get) => ({
  boardId: null,
  boardName: "",
  loaded: false,
  history: { past: [], present: emptyCanvasState(), future: [] },
  selection: [],
  selectedConnectorIds: [],
  tool: "select",
  editingTextId: null,
  saveStatus: "idle",

  loadBoard: (id) => loadBoardImpl(set, get, id),

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
      selection: [],
      selectedConnectorIds: [],
      tool: "select",
      editingTextId: null,
      saveStatus: "idle",
    });
  },

  flushSave: (opts) => flushSaveImpl(set, get, opts),

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

  addImageFromAsset: (a, worldPoint) => {
    const vp = get().history.present.viewport;
    const target = worldPoint ?? viewportCenterWorld(vp);
    const LONG_EDGE = 320;
    const ratio = parseAspectRatio(a.aspectRatio) ?? 1;
    const w = ratio >= 1 ? LONG_EDGE : LONG_EDGE * ratio;
    const h = ratio >= 1 ? LONG_EDGE / ratio : LONG_EDGE;
    const node: ImageNode = {
      id: crypto.randomUUID(),
      type: "image",
      x: target.x - w / 2,
      y: target.y - h / 2,
      w,
      h,
      src: a.url,
      aspectLocked: true,
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
        const frames = next.nodes.filter((n): n is FrameNode => n.type === "frame");
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
    const idMap = new Map<string, string>();
    for (const id of selection) idMap.set(id, crypto.randomUUID());
    const groupIdMap = new Map<string, string>();
    mutateGraph(set, get, (present) => {
      const selSet = new Set(selection);
      const duplicates: CanvasNode[] = [];
      for (const n of present.nodes) {
        if (!selSet.has(n.id)) continue;
        const newId = idMap.get(n.id) as string;
        let newGroupId: string | null = null;
        if (n.groupId) {
          if (!groupIdMap.has(n.groupId)) groupIdMap.set(n.groupId, crypto.randomUUID());
          newGroupId = groupIdMap.get(n.groupId) as string;
        }
        const newParentId =
          n.parentId && idMap.has(n.parentId) ? (idMap.get(n.parentId) as string) : (n.parentId ?? null);
        duplicates.push({
          ...n,
          id: newId,
          x: n.x + 20,
          y: n.y + 20,
          parentId: newParentId,
          groupId: newGroupId,
        });
      }
      return { ...present, nodes: [...present.nodes, ...duplicates] };
    });
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
    const connector: Connector = {
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

  copy: () => {
    const { selection, history } = get();
    if (!selection.length) return;
    const selSet = new Set(selection);
    clipboard = history.present.nodes.filter((n) => selSet.has(n.id)).map((n) => ({ ...n }));
  },

  paste: () => {
    if (!clipboard.length) return;
    const idMap = new Map<string, string>();
    for (const n of clipboard) idMap.set(n.id, crypto.randomUUID());
    const groupIdMap = new Map<string, string>();
    mutateGraph(set, get, (present) => {
      const pasted = clipboard.map((n) => {
        let newGroupId: string | null = null;
        if (n.groupId) {
          if (!groupIdMap.has(n.groupId)) groupIdMap.set(n.groupId, crypto.randomUUID());
          newGroupId = groupIdMap.get(n.groupId) as string;
        }
        return {
          ...n,
          id: idMap.get(n.id) as string,
          x: n.x + 20,
          y: n.y + 20,
          parentId: n.parentId && idMap.has(n.parentId) ? (idMap.get(n.parentId) as string) : null,
          groupId: newGroupId,
        };
      });
      return { ...present, nodes: [...present.nodes, ...pasted] };
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
export function frameNodesOf(state: CanvasState): FrameNode[] {
  return state.nodes.filter((n): n is FrameNode => n.type === "frame");
}
