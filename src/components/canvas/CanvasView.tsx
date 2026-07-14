"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, AlertTriangle, AlertCircle, Monitor } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStore } from "@/lib/store";
import { useCanvasStore } from "@/lib/canvas-store";
import {
  CanvasSurface,
  buildDefaultNode,
  uploadImageFile,
  type CanvasSurfaceHandle,
  type CreateTool,
} from "./CanvasSurface";
import { CanvasToolbar } from "./CanvasToolbar";
import { StyleInspector } from "./StyleInspector";
import { BoardSwitcher } from "./BoardSwitcher";
import { CanvasAssetPanel } from "./CanvasAssetPanel";

const CREATE_TOOLS: CreateTool[] = ["rect", "ellipse", "triangle", "diamond", "text", "sticky", "frame"];
const SHAPE_SHORTCUTS: Record<string, CreateTool> = {
  s: "sticky",
  t: "text",
  f: "frame",
};

export function CanvasView() {
  const activeProjectId = useStore((s) => s.activeProjectId);

  const [boardId, setBoardId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [toolLocked, setToolLocked] = useState(false);
  const [assetPanelCollapsed, setAssetPanelCollapsed] = useState(false);
  const [transientActive, setTransientActive] = useState(false);
  const [tooSmall, setTooSmall] = useState(false);

  const surfaceRef = useRef<CanvasSurfaceHandle>(null);

  const loaded = useCanvasStore((s) => s.loaded);
  const saveStatus = useCanvasStore((s) => s.saveStatus);
  const loadBoard = useCanvasStore((s) => s.loadBoard);
  const reset = useCanvasStore((s) => s.reset);
  const flushSave = useCanvasStore((s) => s.flushSave);
  const setTool = useCanvasStore((s) => s.setTool);
  const undo = useCanvasStore((s) => s.undo);
  const redo = useCanvasStore((s) => s.redo);
  const deleteSelected = useCanvasStore((s) => s.deleteSelected);
  const duplicateSelected = useCanvasStore((s) => s.duplicateSelected);
  const selectAll = useCanvasStore((s) => s.selectAll);
  const clearSelection = useCanvasStore((s) => s.clearSelection);
  const zoomToFit = useCanvasStore((s) => s.zoomToFit);
  const setViewport = useCanvasStore((s) => s.setViewport);
  const addNode = useCanvasStore((s) => s.addNode);
  const addImageFromAsset = useCanvasStore((s) => s.addImageFromAsset);

  // ── board load lifecycle ─────────────────────────────────────────────
  useEffect(() => {
    if (!boardId) return;
    let cancelled = false;
    setLoadError(false);
    loadBoard(boardId).catch(() => {
      if (!cancelled) setLoadError(true);
    });
    return () => {
      cancelled = true;
    };
  }, [boardId, loadBoard]);

  // reset canvas-store when leaving the board view entirely (unmount)
  useEffect(() => {
    return () => {
      flushSave({ keepalive: true });
      reset();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // force-flush on tab hide / navigation away
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushSave({ keepalive: true });
    };
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      flushSave({ keepalive: true });
      const status = useCanvasStore.getState().saveStatus;
      if (status === "dirty" || status === "error") {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [flushSave]);

  // responsive desktop-only gate (ui-spec A1 / §10)
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px) and (hover: hover) and (pointer: fine)");
    const update = () => setTooSmall(!mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  const placeAsset = useCallback(
    (asset: { url: string; aspectRatio?: string }) => {
      const center = surfaceRef.current?.getViewportCenterWorld() ?? { x: 0, y: 0 };
      addImageFromAsset(asset, center);
    },
    [addImageFromAsset]
  );

  const addImageFile = useCallback(
    async (file: File) => {
      if (!boardId) return;
      const url = await uploadImageFile(file, boardId);
      if (url) placeAsset({ url });
    },
    [boardId, placeAsset]
  );

  // ── document-level keyboard shortcuts (ui-spec §11) ─────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const editing =
        target?.isContentEditable || target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
      if (editing) return;

      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        duplicateSelected();
        return;
      }
      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        selectAll();
        return;
      }
      if (mod && e.key === "0") {
        e.preventDefault();
        const vp = useCanvasStore.getState().history.present.viewport;
        setViewport({ ...vp, zoom: 1 });
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSelected();
        return;
      }
      if (e.key === "Escape") {
        clearSelection();
        setTool("select");
        return;
      }
      if (e.key === "!" && e.shiftKey) {
        zoomToFit();
        return;
      }
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
        const selection = useCanvasStore.getState().selection;
        if (!selection.length) return;
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        useCanvasStore.getState().moveSelectionBy(dx, dy);
        return;
      }
      if (e.key === "Tab") {
        const s = useCanvasStore.getState();
        const nodes = s.history.present.nodes;
        if (!nodes.length) return;
        e.preventDefault();
        const curIdx = s.selection.length ? nodes.findIndex((n) => n.id === s.selection[0]) : -1;
        const nextIdx = e.shiftKey
          ? (curIdx - 1 + nodes.length) % nodes.length
          : (curIdx + 1) % nodes.length;
        s.setSelection([nodes[nextIdx].id]);
        return;
      }
      if (e.key === "Enter") {
        const tool = useCanvasStore.getState().tool;
        if (CREATE_TOOLS.includes(tool as CreateTool)) {
          const center = surfaceRef.current?.getViewportCenterWorld() ?? { x: 0, y: 0 };
          const node = buildDefaultNode(tool as CreateTool, center);
          addNode(node);
          useCanvasStore.getState().setSelection([node.id]);
          if (node.type === "text" || node.type === "sticky") {
            useCanvasStore.getState().setEditingTextId(node.id);
          }
          if (!toolLocked) setTool("select");
        }
        return;
      }

      // tool letter shortcuts
      const key = e.key.toLowerCase();
      if (key === "v") setTool("select");
      else if (key === "h") setTool("hand");
      else if (key === "r") setTool("rect");
      else if (key === "c") setTool("connector");
      else if (SHAPE_SHORTCUTS[key]) setTool(SHAPE_SHORTCUTS[key]);
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [
    undo,
    redo,
    duplicateSelected,
    selectAll,
    clearSelection,
    deleteSelected,
    setTool,
    zoomToFit,
    setViewport,
    addNode,
    toolLocked,
  ]);

  const assetPanelWidth = assetPanelCollapsed ? 44 : 300;

  return (
    <div className="relative min-w-0 flex-1 overflow-hidden bg-ink-900">
      <CanvasSurface
        ref={surfaceRef}
        toolLocked={toolLocked}
        onAfterSingleShotPlace={() => setTool("select")}
        boardId={boardId}
        onTransientChange={setTransientActive}
      />

      <CanvasAssetPanel onPlaceAtCenter={placeAsset} onCollapsedChange={setAssetPanelCollapsed} />

      {/* while board JSON is loading, the switcher/dock/zoom render but stay
          disabled/dimmed (ui-spec §9); the asset panel loads independently */}
      <div className={cn(!loaded && boardId && "pointer-events-none opacity-50")}>
        <BoardSwitcher
          projectId={activeProjectId}
          boardId={boardId}
          onBoardIdChange={setBoardId}
          leftOffset={assetPanelWidth + 16}
        />
        <CanvasToolbar
          toolLocked={toolLocked}
          onToggleLock={() => setToolLocked((v) => !v)}
          onAddImageFile={addImageFile}
        />
      </div>

      <SaveStatusChip status={saveStatus} onRetry={() => flushSave()} />

      <StyleInspector hidden={transientActive} />

      {loadError && (
        <div className="absolute inset-0 z-40 grid place-items-center bg-ink-900/90">
          <div className="flex flex-col items-center gap-3 text-center">
            <AlertCircle className="h-7 w-7 text-red-400/90" />
            <p className="text-sm text-white/70">Couldn't load this board.</p>
            <button
              type="button"
              onClick={() => boardId && loadBoard(boardId).then(() => setLoadError(false)).catch(() => setLoadError(true))}
              className="rounded-lg bg-brand/20 px-3 py-1.5 text-sm font-semibold text-brand hover:bg-brand/30"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {tooSmall && (
        <div className="absolute inset-0 z-50 grid place-items-center bg-ink-900/95 text-center">
          <div className="flex max-w-xs flex-col items-center gap-3 px-6">
            <Monitor className="h-8 w-8 text-white/50" />
            <p className="text-sm font-medium text-white/85">Canvas Board needs a larger screen.</p>
            <p className="text-sm text-white/55">
              Open Vivi on a desktop (1024px or wider) to use the board.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function SaveStatusChip({
  status,
  onRetry,
}: {
  status: "idle" | "dirty" | "saving" | "saved" | "error";
  onRetry: () => void;
}) {
  if (status === "error") {
    return (
      <div className="absolute right-4 top-4 z-30 flex items-center gap-2 rounded-full bg-amber-400/15 px-3 py-1.5 text-xs font-medium text-amber-200 ring-1 ring-amber-400/40">
        <AlertTriangle className="h-3.5 w-3.5" />
        Couldn't save — retrying
        <button
          type="button"
          onClick={onRetry}
          className="rounded-full bg-amber-400/20 px-2 py-0.5 text-[11px] font-semibold hover:bg-amber-400/30"
        >
          Retry
        </button>
      </div>
    );
  }
  if (status === "saving" || status === "dirty") {
    return (
      <div className="absolute right-4 top-4 z-30 flex items-center gap-1.5 rounded-full border border-line bg-ink-750/95 px-3 py-1.5 text-xs text-white/60 shadow-pop backdrop-blur-xl">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Saving…
      </div>
    );
  }
  return (
    <div className="absolute right-4 top-4 z-30 flex items-center gap-1.5 rounded-full border border-line bg-ink-750/95 px-3 py-1.5 text-xs text-white/45 shadow-pop backdrop-blur-xl">
      <Check className="h-3.5 w-3.5" />
      Saved
    </div>
  );
}
