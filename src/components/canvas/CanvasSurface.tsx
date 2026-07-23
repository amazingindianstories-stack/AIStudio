"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Shapes, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStore } from "@/lib/store";
import { useCanvasStore, hasClipboard } from "@/lib/canvas-store";
import type { Anchor, CanvasNode, CanvasState, Endpoint, FrameNode } from "@/lib/canvas/types";
import {
  computeFrameMembership,
  hitTest,
  marqueeHits,
  moveNodesBy,
  nodeBounds,
  resizeNode,
  screenToWorld,
} from "@/lib/canvas/geometry";
import { selectionActions } from "@/lib/canvas/selection-actions";
import { NodeView, type ResizeHandle } from "./nodes/NodeView";
import { ConnectorLayer } from "./ConnectorLayer";
import { CanvasContextMenu, type ContextMenuAction } from "./CanvasContextMenu";

export type CreateTool = "rect" | "ellipse" | "triangle" | "diamond" | "text" | "sticky" | "frame";

const CREATE_TOOLS: CreateTool[] = ["rect", "ellipse", "triangle", "diamond", "text", "sticky", "frame"];

/** Builds a fully-formed default-sized node centered at `center` (world
 *  coords), ready for `addNode`. Shared by canvas click-to-place and the
 *  Enter-to-place accessibility path (§11). */
export function buildDefaultNode(tool: CreateTool, center: { x: number; y: number }): CanvasNode {
  const id = crypto.randomUUID();
  const base = { id, opacity: 1, parentId: null, groupId: null };
  switch (tool) {
    case "rect":
    case "ellipse":
    case "triangle":
    case "diamond":
      return {
        ...base,
        type: tool,
        x: center.x - 80,
        y: center.y - 60,
        w: 160,
        h: 120,
        fill: "rgba(255,255,255,0.06)",
        stroke: "rgba(255,255,255,0.55)",
        strokeWidth: 2,
        cornerRadius: tool === "rect" ? 0 : undefined,
      };
    case "text":
      return {
        ...base,
        type: "text",
        x: center.x - 100,
        y: center.y - 16,
        w: 200,
        h: 32,
        text: "",
        fontSize: 16,
        align: "left",
        color: "#ffffff",
      };
    case "sticky":
      return {
        ...base,
        type: "sticky",
        x: center.x - 100,
        y: center.y - 100,
        w: 200,
        h: 200,
        text: "",
        fill: "#e3c56a",
        fontSize: 16,
        color: "#1c1a12",
      };
    case "frame":
      return {
        ...base,
        type: "frame",
        x: center.x - 320,
        y: center.y - 200,
        w: 640,
        h: 400,
        name: "Untitled frame",
        fill: "rgba(255,255,255,0.02)",
        stroke: "rgba(255,255,255,0.12)",
      };
  }
}

export interface CanvasSurfaceHandle {
  getViewportCenterWorld(): { x: number; y: number };
}

type DragKind = "pan" | "marquee" | "move" | "resize" | "connector" | "create" | "connector-endpoint";

interface DragState {
  kind: DragKind;
  startScreen: { x: number; y: number };
  startWorld: { x: number; y: number };
  // resize
  resizeNodeId?: string;
  resizeHandle?: ResizeHandle;
  resizeStartNode?: CanvasNode;
  // connector (create)
  connectorFromId?: string;
  connectorFromAnchor?: Anchor;
  connectorFromPoint?: { x: number; y: number };
  // create
  createTool?: CreateTool;
  moved: boolean;
  // move (C1 alt-drag-duplicate / C2 shift-drag-axis-constrain + deferred shift-deselect)
  altDuplicate?: boolean;
  altDuplicated?: boolean;
  pendingDeselectId?: string;
  // connector-endpoint (D)
  endpointConnectorId?: string;
  endpointEnd?: "from" | "to";
}

export const CanvasSurface = forwardRef<
  CanvasSurfaceHandle,
  {
    toolLocked: boolean;
    onAfterSingleShotPlace: () => void;
    boardId: string | null;
    /** Fires while a move/resize/pan gesture is in progress — StyleInspector
     *  hides for the duration (ui-spec §5) and reappears on release. */
    onTransientChange?: (active: boolean) => void;
  }
>(function CanvasSurface({ toolLocked, onAfterSingleShotPlace, boardId, onTransientChange }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  const loaded = useCanvasStore((s) => s.loaded);
  const present = useCanvasStore((s) => s.history.present);
  const selection = useCanvasStore((s) => s.selection);
  const selectedConnectorIds = useCanvasStore((s) => s.selectedConnectorIds);
  const tool = useCanvasStore((s) => s.tool);
  const editingTextId = useCanvasStore((s) => s.editingTextId);
  const setSelection = useCanvasStore((s) => s.setSelection);
  const toggleSelect = useCanvasStore((s) => s.toggleSelect);
  const clearSelection = useCanvasStore((s) => s.clearSelection);
  const setViewport = useCanvasStore((s) => s.setViewport);
  const addNode = useCanvasStore((s) => s.addNode);
  const addImageFromAsset = useCanvasStore((s) => s.addImageFromAsset);
  const addConnector = useCanvasStore((s) => s.addConnector);
  const moveSelectionBy = useCanvasStore((s) => s.moveSelectionBy);
  const resizeSelected = useCanvasStore((s) => s.resizeSelected);
  const duplicateSelectionInPlace = useCanvasStore((s) => s.duplicateSelectionInPlace);
  const updateConnectorEndpoint = useCanvasStore((s) => s.updateConnectorEndpoint);
  const keepGestureAlive = useCanvasStore((s) => s.keepGestureAlive);

  const items = useStore((s) => s.items);

  const viewport = present.viewport;

  const [spaceHeld, setSpaceHeld] = useState(false);
  const [preview, setPreview] = useState<CanvasState | null>(null);
  const [marqueeScreen, setMarqueeScreen] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [dropHighlightFrameId, setDropHighlightFrameId] = useState<string | null>(null);
  const [dragGhost, setDragGhost] = useState<{ x: number; y: number } | null>(null);
  const [draftConnector, setDraftConnector] = useState<{ fromPoint: { x: number; y: number }; toPoint: { x: number; y: number } } | null>(null);
  const [connectorHoverTargetId, setConnectorHoverTargetId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const displayState = preview ?? present;
  const nodesById = useMemo(() => {
    const map: Record<string, CanvasNode> = {};
    for (const n of displayState.nodes) map[n.id] = n;
    return map;
  }, [displayState.nodes]);
  const childCountByFrame = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const n of displayState.nodes) {
      if (n.parentId) counts[n.parentId] = (counts[n.parentId] ?? 0) + 1;
    }
    return counts;
  }, [displayState.nodes]);
  const renderedNodes = useMemo(() => {
    // Large storyboard boards can contain thousands of nodes. Mounting every
    // off-screen image at once floods the authenticated media route and leaves
    // transiently failed <img> requests behind. Keep a generous screen-space
    // overscan so panning still feels immediate while only nearby media mounts.
    const overscanPx = 900;
    const overscanWorld = overscanPx / viewport.zoom;
    const left = viewport.x - overscanWorld;
    const top = viewport.y - overscanWorld;
    const right = viewport.x + size.w / viewport.zoom + overscanWorld;
    const bottom = viewport.y + size.h / viewport.zoom + overscanWorld;
    const selected = new Set(selection);

    return displayState.nodes.filter((node) => {
      if (selected.has(node.id)) return true;
      return (
        node.x + node.w >= left &&
        node.x <= right &&
        node.y + node.h >= top &&
        node.y <= bottom
      );
    });
  }, [displayState.nodes, selection, size.h, size.w, viewport.x, viewport.y, viewport.zoom]);

  useImperativeHandle(ref, () => ({
    getViewportCenterWorld: () => ({
      x: viewport.x + size.w / 2 / viewport.zoom,
      y: viewport.y + size.h / 2 / viewport.zoom,
    }),
  }));

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) {
        setSize({ w: r.width, h: r.height });
        useCanvasStore.getState().setViewportSize(r.width, r.height);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // space-to-pan
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat) {
        const target = e.target as HTMLElement | null;
        if (target?.isContentEditable || target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
        setSpaceHeld(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceHeld(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  const toScreenLocal = useCallback((clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  }, []);

  const isPanning = tool === "hand" || spaceHeld;

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const local = toScreenLocal(e.clientX, e.clientY);
      if (e.ctrlKey || e.metaKey) {
        // zoom toward cursor
        const worldBefore = screenToWorld(local, viewport);
        const factor = Math.exp(-e.deltaY * 0.01);
        const nextZoom = Math.min(4, Math.max(0.1, viewport.zoom * factor));
        const nextVp = {
          zoom: nextZoom,
          x: worldBefore.x - local.x / nextZoom,
          y: worldBefore.y - local.y / nextZoom,
        };
        setViewport(nextVp);
      } else {
        setViewport({
          ...viewport,
          x: viewport.x + e.deltaX / viewport.zoom,
          y: viewport.y + e.deltaY / viewport.zoom,
        });
      }
    },
    [viewport, setViewport, toScreenLocal]
  );

  const beginPan = (screen: { x: number; y: number }) => {
    dragRef.current = {
      kind: "pan",
      startScreen: screen,
      startWorld: screenToWorld(screen, viewport),
      moved: false,
    };
    onTransientChange?.(true);
  };

  const onPointerDownBackground = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const screen = toScreenLocal(e.clientX, e.clientY);

    if (isPanning) {
      beginPan(screen);
      return;
    }

    if (CREATE_TOOLS.includes(tool as CreateTool)) {
      dragRef.current = {
        kind: "create",
        startScreen: screen,
        startWorld: screenToWorld(screen, viewport),
        createTool: tool as CreateTool,
        moved: false,
      };
      return;
    }

    if (tool === "connector") {
      // Starting on empty canvas begins a free-standing line/arrow (a
      // connector with a free {x,y} "from" endpoint) — the same primitive
      // as a node-to-node connector, just unattached on this end.
      const worldPoint = screenToWorld(screen, viewport);
      setDraftConnector({ fromPoint: worldPoint, toPoint: worldPoint });
      dragRef.current = {
        kind: "connector",
        startScreen: screen,
        startWorld: worldPoint,
        connectorFromPoint: worldPoint,
        moved: false,
      };
      return;
    }

    if (tool === "select") {
      if (!e.shiftKey) clearSelection();
      dragRef.current = {
        kind: "marquee",
        startScreen: screen,
        startWorld: screenToWorld(screen, viewport),
        moved: false,
      };
      setMarqueeScreen({ x0: screen.x, y0: screen.y, x1: screen.x, y1: screen.y });
    }
  };

  const onPointerDownNode = (e: React.PointerEvent, node: CanvasNode) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const screen = toScreenLocal(e.clientX, e.clientY);

    if (isPanning) {
      beginPan(screen);
      return;
    }

    if (tool === "connector") {
      setDraftConnector({ fromPoint: { x: node.x + node.w / 2, y: node.y + node.h / 2 }, toPoint: screenToWorld(screen, viewport) });
      dragRef.current = {
        kind: "connector",
        startScreen: screen,
        startWorld: screenToWorld(screen, viewport),
        connectorFromId: node.id,
        connectorFromAnchor: "auto",
        moved: false,
      };
      return;
    }

    if (tool === "select") {
      // Alt/Option takes precedence over shift's multi-select toggle (C1):
      // ensure the node is part of the selection (adding it if needed, but
      // never dropping an existing multi-selection), then start a move drag
      // flagged for duplicate-in-place-then-drag on the first real move.
      let altDuplicate = false;
      let pendingDeselectId: string | undefined;
      if (e.altKey) {
        altDuplicate = true;
        if (!selection.includes(node.id)) setSelection([...selection, node.id]);
      } else if (e.shiftKey) {
        // C2: a shift-drag on an UNSELECTED node adds it and starts moving
        // (matches shift-click's "add" half). A shift-drag on an ALREADY
        // selected node must not toggle it out immediately — that would
        // drop the very node the user is about to drag — so the
        // deselect-on-click is deferred to pointer-up via
        // `pendingDeselectId`, only realized if the gesture never moved
        // (i.e. it really was a plain shift-click, not a shift-drag).
        if (!selection.includes(node.id)) {
          setSelection([...selection, node.id]);
        } else {
          pendingDeselectId = node.id;
        }
      } else if (!selection.includes(node.id)) {
        setSelection([node.id]);
      }
      dragRef.current = {
        kind: "move",
        startScreen: screen,
        startWorld: screenToWorld(screen, viewport),
        moved: false,
        altDuplicate,
        pendingDeselectId,
      };
      onTransientChange?.(true);
    }
  };

  const onPointerDownHandle = (e: React.PointerEvent, node: CanvasNode, handle: ResizeHandle) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const screen = toScreenLocal(e.clientX, e.clientY);
    dragRef.current = {
      kind: "resize",
      startScreen: screen,
      startWorld: screenToWorld(screen, viewport),
      resizeNodeId: node.id,
      resizeHandle: handle,
      resizeStartNode: node,
      moved: false,
    };
    onTransientChange?.(true);
  };

  const onConnectorHandlePointerDown = (e: React.PointerEvent, node: CanvasNode, anchor: Anchor) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const screen = toScreenLocal(e.clientX, e.clientY);
    const b = nodeBounds(node);
    const anchorPoint =
      anchor === "top"
        ? { x: b.x + b.w / 2, y: b.y }
        : anchor === "bottom"
        ? { x: b.x + b.w / 2, y: b.y + b.h }
        : anchor === "left"
        ? { x: b.x, y: b.y + b.h / 2 }
        : { x: b.x + b.w, y: b.y + b.h / 2 };
    setDraftConnector({ fromPoint: anchorPoint, toPoint: screenToWorld(screen, viewport) });
    dragRef.current = {
      kind: "connector",
      startScreen: screen,
      startWorld: screenToWorld(screen, viewport),
      connectorFromId: node.id,
      connectorFromAnchor: anchor,
      moved: false,
    };
  };

  // (D) Grab a selected connector's endpoint dot — mirrors how resize
  // handles capture the pointer (NodeView.tsx:151) while subsequent events
  // still bubble through this same container's onPointerMove/onPointerUp.
  const onEndpointPointerDown = (
    e: React.PointerEvent,
    connectorId: string,
    end: "from" | "to"
  ) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const screen = toScreenLocal(e.clientX, e.clientY);
    dragRef.current = {
      kind: "connector-endpoint",
      startScreen: screen,
      startWorld: screenToWorld(screen, viewport),
      endpointConnectorId: connectorId,
      endpointEnd: end,
      moved: false,
    };
    onTransientChange?.(true);
  };

  // (C3) Right-click on a connector's fat hit-path — select it (replacing
  // any node selection) and open the menu here, so the container's own
  // onContextMenu (below) never also fires for the same event.
  const onConnectorContextMenu = (
    e: React.PointerEvent | React.MouseEvent,
    connectorId: string
  ) => {
    useCanvasStore.setState({ selectedConnectorIds: [connectorId], selection: [] });
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  // (C3) Right-click on the background/a node — selects the node under the
  // cursor (Figma-style: right-click acts on whatever's under it), or
  // clears selection over empty canvas, then opens the menu there.
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const screen = toScreenLocal(e.clientX, e.clientY);
    const worldPoint = screenToWorld(screen, viewport);
    const nodeId = hitTest(present, worldPoint);
    if (nodeId) {
      if (!selection.includes(nodeId)) setSelection([nodeId]);
    } else {
      clearSelection();
    }
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  // Stable identity: CanvasContextMenu's outside-click/Escape/scroll
  // listener effect depends on `onClose`, so an inline arrow here would
  // re-register those document/window listeners on every render while the
  // menu is open (code review MINOR finding — not a leak, just churn).
  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
    // ui-spec §B.2 / Accessibility: return focus to the canvas
    // (role="application" container) on close.
    containerRef.current?.focus();
  }, []);

  const handleContextMenuAction = (action: ContextMenuAction) => {
    const s = useCanvasStore.getState();
    switch (action) {
      case "duplicate":
        s.duplicateSelected();
        break;
      case "copy":
        s.copy();
        break;
      case "paste":
        s.paste();
        break;
      case "delete":
        s.deleteSelected();
        break;
      case "bringToFront":
        s.bringToFront();
        break;
      case "sendToBack":
        s.sendToBack();
        break;
      case "group":
        s.group();
        break;
      case "ungroup":
        s.ungroup();
        break;
    }
    setContextMenu(null);
  };

  const onDoubleClickBody = (e: React.MouseEvent, node: CanvasNode) => {
    e.stopPropagation();
    if (node.type === "text" || node.type === "sticky" || node.type === "frame") {
      setSelection([node.id]);
      useCanvasStore.getState().setEditingTextId(node.id);
    }
  };

  const onCommitText = (nodeId: string, text: string) => {
    const node = nodesById[nodeId];
    if (!node) return;
    // `name` is the FrameNode label field, `text` is TextNode/StickyNode content.
    const patch = node.type === "frame" ? { name: text } : { text };
    useCanvasStore.getState().updateSelectedStyle(patch);
    useCanvasStore.getState().setEditingTextId(null);
  };
  const onCancelEdit = () => useCanvasStore.getState().setEditingTextId(null);

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const screen = toScreenLocal(e.clientX, e.clientY);
    const dx = screen.x - drag.startScreen.x;
    const dy = screen.y - drag.startScreen.y;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true;

    if (drag.kind === "pan") {
      const worldDx = dx / viewport.zoom;
      const worldDy = dy / viewport.zoom;
      setViewport({ ...viewport, x: viewport.x - worldDx, y: viewport.y - worldDy });
      drag.startScreen = screen;
      return;
    }

    if (drag.kind === "marquee") {
      setMarqueeScreen({ x0: drag.startScreen.x, y0: drag.startScreen.y, x1: screen.x, y1: screen.y });
      return;
    }

    if (drag.kind === "move") {
      // C1: on the first move past the 2px threshold, an alt-held drag
      // duplicates the selection IN PLACE (zero offset) and re-targets this
      // same gesture onto the duplicates — skip this one tick so the very
      // next event reads the fresh (post-duplicate) selection/present
      // rather than a stale closure (design.md's "Alt-drag stale-closure"
      // risk). `startScreen` is deliberately NOT reset, so the total delta
      // committed in endDrag still measures from the original pointer-down.
      if (drag.altDuplicate && !drag.altDuplicated && drag.moved) {
        duplicateSelectionInPlace();
        drag.altDuplicated = true;
        return;
      }
      // The duplicate above and the eventual moveSelectionBy commit in
      // endDrag are two separate coalesced mutations that must fuse into
      // one undo step; every tick in between only touches local preview
      // state, so without this the idle timer can lapse mid-drag and split
      // them into two history entries (code review MAJOR finding).
      if (drag.altDuplicated) keepGestureAlive();
      const worldDx = dx / viewport.zoom;
      const worldDy = dy / viewport.zoom;
      // C2: shift-drag constrains movement to the dominant axis, evaluated
      // live off the CUMULATIVE delta (worldDx/worldDy are already
      // cumulative-since-gesture-start, same as the unconstrained path) —
      // no separate commit-time logic needed since endDrag reads `preview`.
      let constrainedDx = worldDx;
      let constrainedDy = worldDy;
      if (e.shiftKey) {
        if (Math.abs(worldDx) >= Math.abs(worldDy)) constrainedDy = 0;
        else constrainedDx = 0;
      }
      const next = moveNodesBy(present, selection, constrainedDx, constrainedDy);
      // frame drop-highlight preview
      const movedNode = next.nodes.find((n) => n.id === selection[0]);
      if (movedNode && movedNode.type !== "frame") {
        const frames = next.nodes.filter((n): n is FrameNode => n.type === "frame");
        const targetFrame = computeFrameMembership(movedNode, frames);
        setDropHighlightFrameId(targetFrame);
      }
      setPreview(next);
      return;
    }

    if (drag.kind === "resize" && drag.resizeStartNode && drag.resizeNodeId && drag.resizeHandle) {
      const worldDx = dx / viewport.zoom;
      const worldDy = dy / viewport.zoom;
      const keepAspectBase = drag.resizeStartNode.type === "image";
      const keepAspect = e.shiftKey ? !keepAspectBase : keepAspectBase;
      const resized = resizeNode(drag.resizeStartNode, drag.resizeHandle, worldDx, worldDy, keepAspect);
      const nextNodes = present.nodes.map((n) => (n.id === drag.resizeNodeId ? resized : n));
      setPreview({ ...present, nodes: nextNodes });
      return;
    }

    if (drag.kind === "connector" && (drag.connectorFromId || drag.connectorFromPoint)) {
      const worldPoint = screenToWorld(screen, viewport);
      const target = hitTest(present, worldPoint);
      setConnectorHoverTargetId(target && target !== drag.connectorFromId ? target : null);
      setDraftConnector((d) => (d ? { ...d, toPoint: worldPoint } : d));
      return;
    }

    if (drag.kind === "create" && drag.createTool) {
      setDragGhost(screenToWorld(screen, viewport));
    }

    if (drag.kind === "connector-endpoint" && drag.endpointConnectorId && drag.endpointEnd) {
      // Reuses the exact snap-to-node hit-test + hover-highlight the
      // connector CREATE flow already uses (drag.kind === "connector"
      // above) — no new geometry. Mutates the REAL connector every tick
      // (coalesced) so the live preview renders in its true style/curve via
      // connectorPath (untouched, design.md D4), not a dashed draft.
      const worldPoint = screenToWorld(screen, viewport);
      const target = hitTest(present, worldPoint);
      setConnectorHoverTargetId(target);
      const endpoint: Endpoint = target
        ? { nodeId: target, anchor: "auto" }
        : { x: worldPoint.x, y: worldPoint.y };
      updateConnectorEndpoint(drag.endpointConnectorId, drag.endpointEnd, endpoint);
      return;
    }
  };

  const endDrag = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;

    if (drag.kind === "marquee") {
      if (drag.moved) {
        const r = marqueeScreen;
        if (r) {
          const w1 = screenToWorld({ x: r.x0, y: r.y0 }, viewport);
          const w2 = screenToWorld({ x: r.x1, y: r.y1 }, viewport);
          const rect = {
            x: Math.min(w1.x, w2.x),
            y: Math.min(w1.y, w2.y),
            w: Math.abs(w2.x - w1.x),
            h: Math.abs(w2.y - w1.y),
          };
          const hits = marqueeHits(present, rect);
          if (hits.length) setSelection(Array.from(new Set([...selection, ...hits])));
        }
      }
      setMarqueeScreen(null);
      return;
    }

    if (drag.kind === "move") {
      // The preview state already holds the fully-moved nodes (computed via
      // the pure moveNodesBy on every pointermove); diff the selection's
      // anchor node against its pre-drag position to get the exact total
      // delta and commit it as a single gesture-end call.
      if (preview) {
        const movedNode = preview.nodes.find((n) => n.id === selection[0]);
        const originalNode = present.nodes.find((n) => n.id === selection[0]);
        if (movedNode && originalNode && drag.moved) {
          moveSelectionBy(movedNode.x - originalNode.x, movedNode.y - originalNode.y);
        }
      }
      // C2: a shift-drag on an already-selected node deferred its deselect
      // (see onPointerDownNode) — realize it now ONLY if the gesture never
      // actually moved, i.e. it was a plain shift-click, not a shift-drag.
      if (!drag.moved && drag.pendingDeselectId) {
        toggleSelect(drag.pendingDeselectId);
      }
      setPreview(null);
      setDropHighlightFrameId(null);
      return;
    }

    // Resize is committed in onPointerUp (needs the raw pointer event for
    // e.shiftKey at release time), which returns early before reaching here.

    if (drag.kind === "connector") {
      // Either end may be attached (a node) or free (a world point) — a
      // free-standing line/arrow is just a connector with one or both
      // endpoints free, per design.md's unified connector/arrow model.
      const from = drag.connectorFromId
        ? { nodeId: drag.connectorFromId, anchor: drag.connectorFromAnchor ?? ("auto" as const) }
        : (drag.connectorFromPoint ?? null);
      const to = connectorHoverTargetId
        ? { nodeId: connectorHoverTargetId, anchor: "auto" as const }
        : (draftConnector?.toPoint ?? null);
      const isNodeToNode = !!drag.connectorFromId && !!connectorHoverTargetId;
      if (from && to && (isNodeToNode || drag.moved)) {
        addConnector(from, to, "arrow");
        if (!toolLocked) onAfterSingleShotPlace();
      }
      setDraftConnector(null);
      setConnectorHoverTargetId(null);
      return;
    }

    if (drag.kind === "create" && drag.createTool) {
      const node = buildDefaultNode(drag.createTool, drag.startWorld);
      addNode(node);
      setSelection([node.id]);
      if (node.type === "text" || node.type === "sticky") {
        useCanvasStore.getState().setEditingTextId(node.id);
      }
      setDragGhost(null);
      if (!toolLocked) onAfterSingleShotPlace();
      return;
    }

    if (drag.kind === "connector-endpoint") {
      // The connector was already re-targeted live, every tick, via the
      // coalesced updateConnectorEndpoint() in onPointerMove — nothing left
      // to commit here. Just clear the reattach-target highlight; the
      // coalesced gesture finalizes into ONE undo step via the same
      // idle-finalize mechanism moveSelectionBy already relies on.
      setConnectorHoverTargetId(null);
      return;
    }
  };

  // resize commit needs the exact screen delta at release; recompute cleanly
  const onPointerUp = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (drag?.kind === "resize" && drag.resizeStartNode && drag.resizeHandle && drag.resizeNodeId) {
      const screen = toScreenLocal(e.clientX, e.clientY);
      const worldDx = (screen.x - drag.startScreen.x) / viewport.zoom;
      const worldDy = (screen.y - drag.startScreen.y) / viewport.zoom;
      const keepAspectBase = drag.resizeStartNode.type === "image";
      const keepAspect = e.shiftKey ? !keepAspectBase : keepAspectBase;
      if (drag.moved) {
        resizeSelected(drag.resizeHandle, worldDx, worldDy, keepAspect);
      }
      setPreview(null);
      dragRef.current = null;
      onTransientChange?.(false);
      return;
    }
    if (drag?.kind === "move" || drag?.kind === "pan" || drag?.kind === "connector-endpoint") {
      onTransientChange?.(false);
    }
    endDrag();
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragGhost(null);
    const assetId = e.dataTransfer.getData("text/assetId");
    if (assetId) {
      const item = items.find((i) => i.id === assetId);
      if (item) {
        const src = item.kind === "video" ? item.poster ?? item.url : item.url;
        if (src) {
          const screen = toScreenLocal(e.clientX, e.clientY);
          const worldPoint = screenToWorld(screen, viewport);
          addImageFromAsset({ url: src, aspectRatio: item.aspectRatio }, worldPoint);
        }
      }
      return;
    }
    // Direct OS file drop (best-effort; not the primary/AC path).
    const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith("image/"));
    if (file && boardId) {
      const screen = toScreenLocal(e.clientX, e.clientY);
      const worldPoint = screenToWorld(screen, viewport);
      uploadImageFile(file, boardId).then((url) => {
        if (url) addImageFromAsset({ url }, worldPoint);
      });
    }
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragGhost(screenToWorld(toScreenLocal(e.clientX, e.clientY), viewport));
  };

  const marqueeWorldRect = useMemo(() => {
    if (!marqueeScreen) return null;
    const w1 = screenToWorld({ x: marqueeScreen.x0, y: marqueeScreen.y0 }, viewport);
    const w2 = screenToWorld({ x: marqueeScreen.x1, y: marqueeScreen.y1 }, viewport);
    return {
      x: Math.min(w1.x, w2.x),
      y: Math.min(w1.y, w2.y),
      w: Math.abs(w2.x - w1.x),
      h: Math.abs(w2.y - w1.y),
    };
  }, [marqueeScreen, viewport]);

  const cursorClass = isPanning
    ? dragRef.current?.kind === "pan"
      ? "cursor-grabbing"
      : "cursor-grab"
    : dragRef.current?.kind === "move" && dragRef.current?.altDuplicate
    ? "cursor-copy" // C1: the standard, universally-recognized "you are duplicating" affordance
    : dragRef.current?.kind === "connector-endpoint"
    ? "cursor-grabbing"
    : CREATE_TOOLS.includes(tool as CreateTool) || tool === "connector"
    ? "cursor-crosshair"
    : "cursor-default";

  const worldTransform = `scale(${viewport.zoom}) translate(${-viewport.x}px, ${-viewport.y}px)`;

  return (
    <div
      ref={containerRef}
      role="application"
      aria-label="Board canvas"
      tabIndex={0}
      onWheel={onWheel}
      onPointerDown={onPointerDownBackground}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={onContextMenu}
      onDrop={onDrop}
      onDragOver={onDragOver}
      className={cn("absolute inset-0 touch-none overflow-hidden bg-ink-900 outline-none", cursorClass)}
      style={{
        backgroundImage: "radial-gradient(rgba(255,255,255,0.06) 1px, transparent 1px)",
        backgroundSize: `${24 * viewport.zoom}px ${24 * viewport.zoom}px`,
        backgroundPosition: `${-viewport.x * viewport.zoom}px ${-viewport.y * viewport.zoom}px`,
      }}
    >
      <div className="absolute left-0 top-0 origin-top-left" style={{ transform: worldTransform }}>
        {renderedNodes.map((n) => (
          <NodeView
            key={n.id}
            node={n}
            tool={tool}
            showRing={selection.length === 1 && selection[0] === n.id}
            showHandles={selection.length === 1 && selection[0] === n.id && n.type !== "frame"}
            editingTextId={editingTextId}
            dropHighlight={dropHighlightFrameId === n.id}
            dragging={!!dragRef.current}
            hasChildren={(childCountByFrame[n.id] ?? 0) > 0}
            onPointerDownBody={onPointerDownNode}
            onDoubleClickBody={onDoubleClickBody}
            onCommitText={onCommitText}
            onCancelEdit={onCancelEdit}
            onPointerDownHandle={onPointerDownHandle}
            onConnectorHandlePointerDown={onConnectorHandlePointerDown}
            connectorHoverTarget={connectorHoverTargetId === n.id}
          />
        ))}

        {selection.length > 1 && (
          <MultiSelectBox nodes={displayState.nodes.filter((n) => selection.includes(n.id))} />
        )}

        <ConnectorLayer
          connectors={displayState.connectors}
          nodesById={nodesById}
          selectedConnectorIds={selectedConnectorIds}
          onSelectConnector={(id, additive) => {
            // toggleSelect already branches on node-vs-connector id internally.
            if (additive) toggleSelect(id);
            else useCanvasStore.setState({ selectedConnectorIds: [id], selection: [] });
          }}
          marqueeWorldRect={marqueeWorldRect}
          draftConnector={draftConnector}
          onEndpointPointerDown={onEndpointPointerDown}
          onConnectorContextMenu={onConnectorContextMenu}
        />

        {dragGhost && CREATE_TOOLS.includes(tool as CreateTool) && (
          <div
            className="pointer-events-none absolute rounded-md border border-dashed border-white/40"
            style={{ left: dragGhost.x - 30, top: dragGhost.y - 22, width: 60, height: 44 }}
          />
        )}
      </div>

      {contextMenu && (
        <CanvasContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          flags={selectionActions(present, selection, selectedConnectorIds, hasClipboard() ? 1 : 0)}
          onAction={handleContextMenuAction}
          onClose={closeContextMenu}
        />
      )}

      {!loaded && (
        <div className="absolute inset-0 grid place-items-center bg-ink-900/60">
          <div className="flex flex-col items-center gap-2 text-white/70">
            <Loader2 className="h-6 w-6 animate-spin text-brand/80" />
            <span className="text-sm">Loading board…</span>
          </div>
        </div>
      )}

      {loaded && present.nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-ink-700 ring-1 ring-line">
            <Shapes className="h-6 w-6 text-white/40" />
          </div>
          <p className="text-sm text-white/55">This board is empty.</p>
          <p className="max-w-xs text-xs text-white/35">
            Pick a tool below, or drag an asset from the left to start your storyboard.
          </p>
        </div>
      )}
    </div>
  );
});

function MultiSelectBox({ nodes }: { nodes: CanvasNode[] }) {
  if (!nodes.length) return null;
  const bounds = nodes.map(nodeBounds);
  const x0 = Math.min(...bounds.map((b) => b.x));
  const y0 = Math.min(...bounds.map((b) => b.y));
  const x1 = Math.max(...bounds.map((b) => b.x + b.w));
  const y1 = Math.max(...bounds.map((b) => b.y + b.h));
  return (
    <div
      className="pointer-events-none absolute ring-1 ring-brand"
      style={{ left: x0, top: y0, width: x1 - x0, height: y1 - y0 }}
    />
  );
}

export async function uploadImageFile(file: File, boardId: string): Promise<string | null> {
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
    const res = await fetch(`/api/canvas-boards/${boardId}/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.url ?? null;
  } catch {
    return null;
  }
}

export { screenToWorld as canvasScreenToWorld };
