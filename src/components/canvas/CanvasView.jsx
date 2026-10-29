"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, AlertTriangle, AlertCircle, Eye, MessageSquare, Lock, Share2, History, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStore } from "@/lib/store";
import { useMediaQuery } from "@/lib/use-media-query";
import { useCanvasStore, selectReadOnly } from "@/lib/canvas-store";
import { isCreateTool } from "@/lib/canvas/shapes";
import { useBoardPolling } from "@/lib/canvas/use-board-polling";
import {
  CanvasSurface,
  buildDefaultNode,
  uploadImageFiles,

} from "./CanvasSurface";
import { CanvasToolbar } from "./CanvasToolbar";
import { StyleInspector } from "./StyleInspector";
import { BoardSwitcher } from "./BoardSwitcher";
import { BoardProjectSelector } from "./BoardProjectSelector";
import { CanvasAssetPanel } from "./CanvasAssetPanel";
import { BoardShareDialog } from "./BoardShareDialog";
import { CanvasAiPanel } from "./CanvasAiPanel";
import { useBoardAi } from "@/lib/board-ai";
import { BoardHistoryPanel } from "./BoardHistoryPanel";
import { ObjectInfo } from "./ObjectInfo";

// Miro's keys: N sticky note, T text, F frame; S opens the shapes panel.
const TOOL_SHORTCUTS = {
  n: "sticky",
  t: "text",
  f: "frame",
};

export function CanvasView() {
  const activeProjectId = useStore((s) => s.activeProjectId);
  const projects = useStore((s) => s.projects);
  const setActiveProject = useStore((s) => s.setActiveProject);

  const [boardId, setBoardId] = useState(null);
  const [boardsLoading, setBoardsLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [toolLocked, setToolLocked] = useState(false);
  const [assetPanelCollapsed, setAssetPanelCollapsed] = useState(false);
  const [transientActive, setTransientActive] = useState(false);
  const [importNotice, setImportNotice] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const closeHistory = useCallback(() => setHistoryOpen(false), []);
  const [shapesOpen, setShapesOpen] = useState(false);
  const [boardsReload, setBoardsReload] = useState(0);
  const [noBoards, setNoBoards] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);

  const surfaceRef = useRef(null);

  const loaded = useCanvasStore((s) => s.loaded);
  const saveStatus = useCanvasStore((s) => s.saveStatus);
  const saveError = useCanvasStore((s) => s.saveError);
  const readOnly = useCanvasStore(selectReadOnly);
  const touchEditMode = useCanvasStore((s) => s.touchEditMode);
  const setTouchEditMode = useCanvasStore((s) => s.setTouchEditMode);
  const boardRole = useCanvasStore((s) => s.boardRole);
  const accessLost = useCanvasStore((s) => s.accessLost);
  const boardName = useCanvasStore((s) => s.boardName);
  const loadBoard = useCanvasStore((s) => s.loadBoard);
  const reset = useCanvasStore((s) => s.reset);
  const flushSave = useCanvasStore((s) => s.flushSave);
  const pollRemote = useCanvasStore((s) => s.pollRemote);
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
  const addImageBatch = useCanvasStore((s) => s.addImageBatch);
  const group = useCanvasStore((s) => s.group);
  const ungroup = useCanvasStore((s) => s.ungroup);
  const bringForward = useCanvasStore((s) => s.bringForward);
  const sendBackward = useCanvasStore((s) => s.sendBackward);
  const bringToFront = useCanvasStore((s) => s.bringToFront);
  const sendToBack = useCanvasStore((s) => s.sendToBack);
  const copy = useCanvasStore((s) => s.copy);
  const paste = useCanvasStore((s) => s.paste);
  const cut = useCanvasStore((s) => s.cut);

  const imageFileInputRef = useRef(null);

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

  // other people's saves appear within seconds while this tab is visible
  useBoardPolling(boardId, pollRemote);

  // The board runs edge to edge under the notch and home indicator (its
  // controls pad for the safe area); the rest of the app stays letterboxed.
  useEffect(() => {
    const meta = document.querySelector('meta[name="viewport"]');
    if (!meta) return;
    const previous = meta.content;
    meta.content = `${previous}, viewport-fit=cover`;
    return () => {
      meta.content = previous;
    };
  }, []);

  // reset canvas-store when leaving the board view entirely (unmount)
  useEffect(() => {
    return () => {
      // The save below may still fail or be cut off; the pending draft survives reset().
      useCanvasStore.getState().persistPendingDraft();
      flushSave({ keepalive: true });
      reset();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // force-flush on tab hide / navigation away
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        useCanvasStore.getState().persistPendingDraft();
        flushSave({ keepalive: true });
      }
    };
    const onBeforeUnload = (e) => {
      useCanvasStore.getState().persistPendingDraft();
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

  // Phones get the compact layout: the asset panel overlays as a drawer and
  // the top controls wrap. Touch-first devices open every board view-only
  // (pan and zoom) until Edit is tapped; a mouse-driven desktop never does.
  const narrow = useMediaQuery("(max-width: 767px)");
  const coarsePointer = useMediaQuery("(pointer: coarse)");
  const touchViewOnly = coarsePointer && !touchEditMode;

  // Explicit board-project switch (BoardProjectSelector) — distinct from
  // CanvasAssetPanel's `scope`, which only filters displayed assets and must
  // never reach this. Clears `boardId` immediately (BoardSwitcher's own
  // effect, keyed on `projectId`, picks/creates a board for the new project
  // and calls `onBoardIdChange` once its fetch resolves) and flushes/resets
  // the currently-loaded board first so its content doesn't linger on
  // screen — mirrors loadBoardImpl's own flush-then-reset ordering.
  const handleBoardProjectChange = useCallback(
    (projectId) => {
      if (projectId === activeProjectId) return;
      flushSave({ keepalive: true });
      reset();
      setBoardId(null);
      setActiveProject(projectId);
    },
    [activeProjectId, flushSave, reset, setActiveProject]
  );

  const placeAsset = useCallback(
    (asset) => {
      const center = surfaceRef.current?.getViewportCenterWorld() ?? { x: 0, y: 0 };
      addImageFromAsset(asset, center);
    },
    [addImageFromAsset]
  );

  const importImageFiles = useCallback(
    async (files, worldPoint) => {
      if (!boardId || selectReadOnly(useCanvasStore.getState())) return;
      const accepted = Array.from(files).filter((file) => file.type.startsWith("image/"));
      if (!accepted.length) return;
      setImportNotice(`Uploading ${accepted.length} image${accepted.length === 1 ? "" : "s"}…`);
      const { images, failed } = await uploadImageFiles(accepted, boardId);
      if (images.length) {
        const target = worldPoint ?? surfaceRef.current?.getViewportCenterWorld() ?? { x: 0, y: 0 };
        addImageBatch(images, target);
      }
      setImportNotice(failed
        ? `${images.length} image${images.length === 1 ? "" : "s"} added; ${failed} failed.`
        : `${images.length} image${images.length === 1 ? "" : "s"} added.`);
      window.setTimeout(() => setImportNotice(""), 3500);
    },
    [boardId, addImageBatch]
  );

  useEffect(() => {
    const onPaste = (event) => {
      const target = event.target;
      if (target?.isContentEditable || target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
      if (touchViewOnly || selectReadOnly(useCanvasStore.getState())) return;
      const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
      event.preventDefault();
      if (files.length) void importImageFiles(files);
      else paste();
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [importImageFiles, paste, touchViewOnly]);

  // Single source of truth for "add image" (⇧I shortcut B / toolbar button)
  // — one hidden file input, one code path, so the toolbar's "(⇧I)" tooltip
  // is finally accurate (spec.md §B gap #1).
  const openImagePicker = useCallback(() => {
    if (selectReadOnly(useCanvasStore.getState())) return;
    imageFileInputRef.current?.click();
  }, []);

  // ── document-level keyboard shortcuts (ui-spec §11) ─────────────────
  useEffect(() => {
    const onKeyDown = (e) => {
      const target = e.target ;
      const editing =
        target?.isContentEditable || target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.tagName === "SELECT" ||
        target?.closest?.('[data-crop-controls], [role="dialog"], [role="alertdialog"]');
      if (editing) return;

      const canvasState = useCanvasStore.getState();
      if (canvasState.croppingImageId && (e.key === "Enter" || e.key === "Escape")) {
        e.preventDefault();
        if (e.key === "Enter") canvasState.applyCrop();
        else canvasState.cancelCrop();
        return;
      }

      const mod = e.metaKey || e.ctrlKey;

      // View only on touch: a hardware keyboard may move the view, never edit.
      if (touchViewOnly && !(mod && e.key === "0") && !(e.key === "!" && e.shiftKey)) return;

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
      if (mod && e.key.toLowerCase() === "g") {
        e.preventDefault();
        if (e.shiftKey) ungroup();
        else group();
        return;
      }
      // Bracket keys MUST be detected via e.code ("BracketRight"/"BracketLeft"),
      // not e.key — with Shift held, e.key for "]"/"[" becomes "}"/"{" on a US
      // layout, so e.code is the only robust, shift-independent discriminator.
      if (mod && e.code === "BracketRight") {
        e.preventDefault();
        if (e.shiftKey) bringToFront();
        else bringForward();
        return;
      }
      if (mod && e.code === "BracketLeft") {
        e.preventDefault();
        if (e.shiftKey) sendToBack();
        else sendBackward();
        return;
      }
      if (mod && e.key.toLowerCase() === "c") {
        e.preventDefault();
        copy();
        return;
      }
      if (mod && e.key.toLowerCase() === "x") {
        e.preventDefault();
        cut();
        return;
      }
      if (mod && e.key.toLowerCase() === "v") {
        // Browser paste event decides whether OS images or internal nodes win.
        return;
      }
      if (!mod && e.shiftKey && e.key.toLowerCase() === "i") {
        e.preventDefault();
        openImagePicker();
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
        if (isCreateTool(tool)) {
          const center = surfaceRef.current?.getViewportCenterWorld() ?? { x: 0, y: 0 };
          const node = buildDefaultNode(tool , center);
          addNode(node);
          useCanvasStore.getState().setSelection([node.id]);
          if (node.type === "text" || node.type === "sticky") {
            useCanvasStore.getState().setEditingTextId(node.id);
          }
          if (!toolLocked) setTool("select");
        }
        return;
      }

      // Latent-bug fix: without this guard, an unhandled mod-combination
      // (e.g. mod+C once it didn't `return` above) falls through to the
      // tool-letter switch below and wrongly re-arms a tool (mod+C used to
      // switch to the connector tool). Every new mod binding above already
      // `return`s before reaching here; this is belt-and-suspenders so NO
      // mod+<letter> combination can ever leak into a tool switch.
      if (mod) return;

      // tool letter shortcuts
      const key = e.key.toLowerCase();
      if (key === "v") setTool("select");
      else if (key === "h") setTool("hand");
      else if (key === "r") setTool("rect");
      else if (key === "c") setTool("connector");
      else if (key === "s") {
        if (!selectReadOnly(useCanvasStore.getState())) setShapesOpen(true);
      } else if (TOOL_SHORTCUTS[key]) setTool(TOOL_SHORTCUTS[key]);
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
    group,
    ungroup,
    bringForward,
    sendBackward,
    bringToFront,
    sendToBack,
    copy,
    cut,
    paste,
    openImagePicker,
    touchViewOnly,
  ]);

  // Board AI jobs follow the loaded, editable board: unfinished jobs resume and finished, unplaced results are placed.
  const loadedBoardId = useCanvasStore((s) => s.boardId);
  useEffect(() => {
    if (!boardId || !loaded || loadedBoardId !== boardId) return;
    if (readOnly) useBoardAi.getState().detach();
    else void useBoardAi.getState().attach(boardId);
  }, [boardId, loaded, loadedBoardId, readOnly]);
  useEffect(() => () => useBoardAi.getState().detach(), []);

  // On phones the open panel overlays the board instead of taking a column.
  const assetPanelWidth = assetPanelCollapsed || narrow ? 44 : 300;
  const showEditToggle = coarsePointer && !readOnly && !noBoards && !!boardId && loaded;

  return (
    <div className="relative min-w-0 flex-1 overflow-hidden bg-ink-900">
      <CanvasSurface
        ref={surfaceRef}
        toolLocked={toolLocked}
        onAfterSingleShotPlace={() => setTool("select")}
        boardId={boardId}
        onTransientChange={setTransientActive}
        onImportFiles={importImageFiles}
        touchViewOnly={touchViewOnly}
      />

      {noBoards && (
        <div
          role="status"
          className="absolute inset-y-0 right-0 z-10 grid place-items-center bg-ink-900 px-6 text-center"
          style={{ left: narrow ? 0 : assetPanelWidth }}
        >
          <div className="flex max-w-xs flex-col items-center gap-3">
            <div className="grid h-14 w-14 place-items-center rounded-2xl bg-ink-700 ring-1 ring-line">
              <Lock className="h-6 w-6 text-white/40" />
            </div>
            <p className="text-sm font-medium text-white/80">No boards yet</p>
            <p className="text-sm text-white/55">Only project editors can add boards to this project.</p>
          </div>
        </div>
      )}

      <CanvasAssetPanel
        projectId={activeProjectId}
        onPlaceAtCenter={readOnly || touchViewOnly || noBoards ? undefined : placeAsset}
        onCollapsedChange={setAssetPanelCollapsed}
      />

      {/* while board JSON is loading (or a board-project switch is in
          flight), the switcher/dock/zoom render but stay disabled/dimmed
          (ui-spec §9); the asset panel loads independently */}
      <div className={cn((boardsLoading || (!loaded && boardId)) && "pointer-events-none opacity-50")}>
        {/* The bar spans the width so it can wrap on phones; only its pills
            take pointer events, the gaps between them reach the canvas. */}
        <div
          className={cn(
            "pointer-events-none absolute top-4 z-30 flex flex-wrap items-center gap-2 transition-[left] duration-200",
            !(boardsLoading || (!loaded && boardId)) && "[&>*]:pointer-events-auto"
          )}
          style={{
            left: `max(${assetPanelWidth + 16}px, calc(env(safe-area-inset-left) + ${assetPanelWidth + 16}px))`,
            right: "max(1rem, env(safe-area-inset-right))",
          }}
        >
          <BoardProjectSelector
            activeProjectId={activeProjectId}
            projects={projects}
            onChange={handleBoardProjectChange}
          />
          <BoardSwitcher
            projectId={activeProjectId}
            boardId={boardId}
            onBoardIdChange={setBoardId}
            onLoadingChange={setBoardsLoading}
            onEmptyChange={setNoBoards}
            reloadToken={boardsReload}
          />
          {boardId && loaded && (
            <button
              type="button"
              onClick={() => setShareOpen(true)}
              className="flex items-center gap-1.5 rounded-full border border-line bg-ink-700 px-3 py-1.5 text-sm text-white/85 outline-none transition hover:text-white focus-visible:ring-2 focus-visible:ring-brand"
            >
              <Share2 className="h-3.5 w-3.5" />
              Share
            </button>
          )}
          {boardId && loaded && !readOnly && (
            <button
              type="button"
              aria-expanded={historyOpen}
              onClick={() => setHistoryOpen((open) => !open)}
              className={cn(
                "flex items-center gap-1.5 rounded-full border border-line bg-ink-700 px-3 py-1.5 text-sm text-white/85 outline-none transition hover:text-white focus-visible:ring-2 focus-visible:ring-brand",
                historyOpen && "bg-ink-600 text-white"
              )}
            >
              <History className="h-3.5 w-3.5" />
              History
            </button>
          )}
          {showEditToggle && (
            <button
              type="button"
              aria-pressed={touchEditMode}
              onClick={() => setTouchEditMode(!touchEditMode)}
              className={cn(
                "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-brand",
                touchEditMode
                  ? "border border-line bg-ink-700 text-white/85 hover:text-white"
                  : "bg-brand text-ink-900 hover:bg-brand/90"
              )}
            >
              {touchEditMode ? <Check className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
              {touchEditMode ? "Done" : "Edit"}
            </button>
          )}
          {!noBoards && (
            <span className="ml-auto">
              {readOnly ? (
                <AccessChip role={boardRole} accessLost={accessLost} />
              ) : touchViewOnly && (saveStatus === "idle" || saveStatus === "saved") ? (
                <AccessChip role="view" accessLost={false} />
              ) : (
                <SaveStatusChip status={saveStatus} error={saveError} onRetry={() => flushSave()} />
              )}
            </span>
          )}
        </div>
        {!noBoards && (
          <CanvasToolbar
            readOnly={readOnly}
            viewOnly={touchViewOnly}
            insetLeft={narrow ? 0 : assetPanelWidth}
            toolLocked={toolLocked}
            shapesOpen={shapesOpen}
            onShapesOpenChange={setShapesOpen}
            onToggleLock={() => setToolLocked((v) => !v)}
            onAddImageClick={openImagePicker}
            aiOpen={aiOpen && Boolean(boardId)}
            onAiClick={() => setAiOpen((v) => !v)}
          />
        )}
        {aiOpen && boardId && !readOnly && !touchViewOnly && <CanvasAiPanel boardId={boardId} leftInset={assetPanelWidth} onClose={() => setAiOpen(false)} />}
      </div>

      <input
        ref={imageFileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        tabIndex={-1}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) void importImageFiles(files);
          e.target.value = "";
        }}
      />

      {shareOpen && boardId && (
        <BoardShareDialog
          boardId={boardId}
          boardName={boardName}
          projectName={projects.find((project) => project.id === activeProjectId)?.name}
          onClose={() => setShareOpen(false)}
          onAccessChange={(access) => {
            useCanvasStore.getState().setBoardRole(access.role);
            setBoardsReload((count) => count + 1);
          }}
        />
      )}

      {importNotice && <div role="status" className="absolute bottom-20 left-1/2 z-40 -translate-x-1/2 rounded-lg border border-line bg-ink-750/95 px-3 py-2 text-xs text-white/80 shadow-pop">{importNotice}</div>}

      <StyleInspector hidden={transientActive || readOnly || touchViewOnly || noBoards} />
      {!noBoards && !transientActive && <ObjectInfo style={{ left: assetPanelWidth + 16 }} />}
      {historyOpen && boardId && loaded && !readOnly && (
        <BoardHistoryPanel key={boardId} boardId={boardId} onClose={closeHistory} />
      )}

      {loadError && (
        <div className="absolute inset-0 z-40 grid place-items-center bg-ink-900/90">
          <div className="flex flex-col items-center gap-3 text-center">
            <AlertCircle className="h-7 w-7 text-red-400/90" />
            <p className="text-sm text-white/70">Could not load this board.</p>
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

    </div>
  );
}

function AccessChip({ role, accessLost }) {
  const Icon = accessLost ? Lock : role === "comment" ? MessageSquare : Eye;
  const label = accessLost
    ? "You can no longer edit this board"
    : role === "comment"
    ? "Comment only"
    : "View only";
  return (
    <div
      role="status"
      className="flex items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-ink-750/95 px-3 py-1.5 text-xs text-white/60 shadow-pop backdrop-blur-xl"
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </div>
  );
}

export function SaveStatusChip({
  status,
  error,
  onRetry,
}

) {
  if (status === "error" && error === "tooLarge") {
    // Resending the same board cannot succeed; the next edit that makes it smaller saves.
    return (
      <div role="alert" className="flex items-center gap-2 whitespace-nowrap rounded-full bg-amber-400/15 px-3 py-1.5 text-xs font-medium text-amber-200 ring-1 ring-amber-400/40">
        <AlertTriangle className="h-3.5 w-3.5" />
        Board too large to save - remove some items and try again
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="flex items-center gap-2 whitespace-nowrap rounded-full bg-amber-400/15 px-3 py-1.5 text-xs font-medium text-amber-200 ring-1 ring-amber-400/40">
        <AlertTriangle className="h-3.5 w-3.5" />
        Could not save - retrying
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
      <div className="flex items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-ink-750/95 px-3 py-1.5 text-xs text-white/60 shadow-pop backdrop-blur-xl">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Saving…
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5 whitespace-nowrap rounded-full border border-line bg-ink-750/95 px-3 py-1.5 text-xs text-white/45 shadow-pop backdrop-blur-xl">
      <Check className="h-3.5 w-3.5" />
      Saved
    </div>
  );
}
