"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AlignLeft,
  AlignCenter,
  AlignRight,
  MoreHorizontal,
  BringToFront,
  SendToBack,
  Copy,
  Trash2,
  Check,
  Minus,
  Square,
  Crop,
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Highlighter,
  Link2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useCanvasStore, } from "@/lib/canvas-store";
import { nodeBounds, resolveEndpoint, worldToScreen } from "@/lib/canvas/geometry";
import { Dropdown, MenuItem } from "@/components/Dropdown";
import { ArrangeControls } from "./ArrangeMenu";
import { isShapeNode } from "@/lib/canvas/shapes";
import { HIGHLIGHT_COLORS } from "@/lib/canvas/rich-text";
import { LockedSelectionBar, LockMenuItems, useSelectionLock } from "./LockControls";
import { TransformControls } from "./TransformControls";
import { ROTATE_HANDLE_REACH, rotationTargets } from "@/lib/canvas/transform";
import {
  activeFormats,
  applyHighlight,
  applyLink,
  normalizeHref,
  onLinkRequest,
  restoreSelection,
  saveSelection,
  toggleFormat,
} from "@/lib/canvas/rich-text-commands";

const RICH_TEXT_TYPES = new Set(["text", "sticky"]);
/** World height of a frame's title strip, which FrameNode draws above the box (`-top-6`). */
const FRAME_TITLE_HEIGHT = 24;

// ~12 monochrome-plus-FigJam-ish swatches — the only saturated color in the
// board's chrome, and it only ever comes from user choice (ui-spec §5).
const PALETTE = [
  { value: "transparent", name: "Transparent" },
  { value: "#ffffff", name: "White" },
  { value: "#d1d5db", name: "Light grey" },
  { value: "#6b7280", name: "Grey" },
  { value: "#e3c56a", name: "Muted yellow" },
  { value: "#7fae86", name: "Muted green" },
  { value: "#6f9bd1", name: "Muted blue" },
  { value: "#d189a7", name: "Muted pink" },
  { value: "#d99a5b", name: "Muted orange" },
  { value: "#9b86c9", name: "Muted purple" },
  { value: "#c97a72", name: "Muted red" },
  { value: "#1c1a12", name: "Ink" },
];

export function StyleInspector({ hidden, insetLeft = 0 }) {
  const selection = useCanvasStore((s) => s.selection);
  const selectedConnectorIds = useCanvasStore((s) => s.selectedConnectorIds);
  const present = useCanvasStore((s) => s.history.present);
  const updateSelectedStyle = useCanvasStore((s) => s.updateSelectedStyle);
  const bringToFront = useCanvasStore((s) => s.bringToFront);
  const sendToBack = useCanvasStore((s) => s.sendToBack);
  const duplicateSelected = useCanvasStore((s) => s.duplicateSelected);
  const deleteSelected = useCanvasStore((s) => s.deleteSelected);
  const beginCrop = useCanvasStore((s) => s.beginCrop);
  const editingTextId = useCanvasStore((s) => s.editingTextId);
  const lock = useSelectionLock();
  const panelRef = useRef(null);
  // Keep the panel inside its container and clear of the asset panel that
  // overlays its left side: it is centred on the selection, which can sit near
  // either edge, so clamp after layout.
  useLayoutEffect(() => {
    const el = panelRef.current;
    const parent = el?.offsetParent;
    if (!el || !parent) return;
    const half = el.offsetWidth / 2;
    const desired = Number.parseFloat(el.dataset.centerX ?? "0");
    const min = insetLeft + half + 8;
    const left = Math.min(Math.max(desired, min), Math.max(parent.clientWidth - half - 8, min));
    el.style.left = `${left}px`;
  });

  // Sets, so a select-all on a board of thousands stays linear.
  const selectedNodeSet = new Set(selection);
  const selectedConnectorSet = new Set(selectedConnectorIds);
  const selectedNodes = present.nodes.filter((n) => selectedNodeSet.has(n.id));
  const selectedConnectors = present.connectors.filter((c) => selectedConnectorSet.has(c.id));

  const hasNodes = selectedNodes.length > 0;
  const hasConnectors = selectedConnectors.length > 0;

  if (hidden || (!hasNodes && !hasConnectors)) return null;

  const viewport = present.viewport;
  const nodesById = {};
  for (const n of present.nodes) nodesById[n.id] = n;

  // union world bounds of everything selected, for anchoring
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const n of selectedNodes) {
    const b = nodeBounds(n);
    bx0 = Math.min(bx0, b.x);
    // The panel sits above a frame's title, not over it.
    by0 = Math.min(by0, n.type === "frame" ? b.y - FRAME_TITLE_HEIGHT : b.y);
    bx1 = Math.max(bx1, b.x + b.w);
    by1 = Math.max(by1, b.y + b.h);
  }
  for (const c of selectedConnectors) {
    try {
      const a = resolveEndpoint(c.from, nodesById);
      const b = resolveEndpoint(c.to, nodesById);
      bx0 = Math.min(bx0, a.x, b.x);
      by0 = Math.min(by0, a.y, b.y);
      bx1 = Math.max(bx1, a.x, b.x);
      by1 = Math.max(by1, a.y, b.y);
    } catch {
      /* stale reference — skip */
    }
  }
  if (!isFinite(bx0)) return null;

  const topLeftScreen = worldToScreen({ x: bx0, y: by0 }, viewport);
  const bottomRightScreen = worldToScreen({ x: bx1, y: by1 }, viewport);
  const centerX = (topLeftScreen.x + bottomRightScreen.x) / 2;
  // Clear of the rotation handle above the selection.
  const gap = 8 + (rotationTargets(present, selection).length ? ROTATE_HANDLE_REACH * viewport.zoom : 0);
  const panelHeight = 44;
  const flipBelow = topLeftScreen.y - panelHeight - gap < 8;
  const top = flipBelow ? bottomRightScreen.y + gap : topLeftScreen.y - panelHeight - gap;

  const types = new Set(selectedNodes.map((n) => n.type));
  const homogeneous = types.size <= 1;
  const soleType = homogeneous ? selectedNodes[0]?.type : undefined;
  const onlyConnectors = hasConnectors && !hasNodes;

  const isShape = selectedNodes.length > 0 && selectedNodes.every(isShapeNode);
  const showFill = isShape || (homogeneous && (soleType === "sticky" || soleType === "frame"));
  const showStroke = isShape;
  const showCornerRadius = homogeneous && soleType === "rect";
  const shapeText = isShape && selectedNodes.every((n) => n.text || n.id === editingTextId);
  const showTextColor = shapeText || (homogeneous && (soleType === "text" || soleType === "sticky"));
  const showFontSize = showTextColor;
  const showTextAlign = homogeneous && soleType === "text";
  const showFrameLabel = homogeneous && soleType === "frame";

  // `updateSelectedStyle` patches BOTH the node `selection` and
  // `selectedConnectorIds` in one call (see canvas-store.ts's
  // `NodeStyleProps`/`applyStylePatchToConnector`), so a connector-only
  // selection is patched through the same call.
  const patch = (p) => updateSelectedStyle(p);
  const editingRichText =
    selection.length === 1 && editingTextId === selection[0] && (RICH_TEXT_TYPES.has(soleType) || isShape);

  // Locked objects take no style changes: the bar says so and offers what this person may do.
  if (lock.allLocked && !hasConnectors) {
    return (
      <div
        ref={panelRef}
        data-center-x={centerX}
        className="absolute z-40 flex h-11 max-w-[calc(100%-1rem)] items-center gap-1 rounded-2xl border border-line bg-ink-750/95 p-1 shadow-pop backdrop-blur-xl"
        style={{ left: centerX, top, transform: "translateX(-50%)" }}
      >
        <LockedSelectionBar lock={lock} />
      </div>
    );
  }

  return (
    <div
      ref={panelRef}
      data-center-x={centerX}
      className="absolute z-40 flex h-11 max-w-[calc(100%-1rem)] items-center gap-1 rounded-2xl border border-line bg-ink-750/95 p-1 shadow-pop backdrop-blur-xl"
      style={{ left: centerX, top, transform: "translateX(-50%)" }}
    >
      {editingRichText && <TextFormatControls popoverBelow={flipBelow} />}

      {/* Only the style controls scroll on narrow screens; the text format
          popovers sit outside this scroller so it cannot clip them. */}
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
        {showFill && (
          <ColorSwatchButton
            label="Fill"
            value={(selectedNodes[0] ).fill ?? "transparent"}
            onChange={(v) => patch({ fill: v })}
          />
        )}

        {(showStroke || onlyConnectors) && (
          <>
            <ColorSwatchButton
              label="Stroke color"
              value={onlyConnectors ? selectedConnectors[0]?.stroke ?? "#ffffff" : (selectedNodes[0] ).stroke}
              onChange={(v) => patch({ stroke: v })}
            />
            <StrokeWidthControl
              value={onlyConnectors ? selectedConnectors[0]?.strokeWidth ?? 2 : (selectedNodes[0] ).strokeWidth ?? 2}
              onChange={(v) => patch({ strokeWidth: v })}
            />
          </>
        )}

        {onlyConnectors && (
          <ArrowheadControl
            kind={selectedConnectors[0]?.kind ?? "arrow"}
            onChange={(kind) => patch({ kind })}
          />
        )}

        {showCornerRadius && (
          <CornerRadiusControl
            value={(selectedNodes[0] ).cornerRadius ?? 0}
            onChange={(v) => patch({ cornerRadius: v })}
          />
        )}

        {showTextColor && (
          <ColorSwatchButton
            label="Text color"
            value={(selectedNodes[0] ).color ?? "#ffffff"}
            onChange={(v) => patch({ color: v })}
          />
        )}

        {showFontSize && (
          <FontSizeControl
            value={(selectedNodes[0] ).fontSize ?? 16}
            onChange={(v) => patch({ fontSize: v })}
          />
        )}

        {showTextAlign && (
          <TextAlignControl
            value={(selectedNodes[0] ).align ?? "left"}
            onChange={(v) => patch({ align: v })}
          />
        )}

        {showFrameLabel && (
          <input
            defaultValue={(selectedNodes[0] ).name ?? ""}
            onBlur={(e) => patch({ name: e.currentTarget.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            placeholder="Frame label"
            className="h-8 w-32 rounded-lg border border-line bg-ink-800 px-2 text-xs text-white outline-none placeholder:text-white/30 focus:border-brand/40"
          />
        )}

        {selection.length === 1 && soleType === "image" && (
          <button type="button" onClick={() => beginCrop(selection[0])} className="grid h-8 w-8 place-items-center rounded-lg text-white/60 hover:bg-white/10 hover:text-white" title="Crop image" aria-label="Crop image"><Crop className="h-4 w-4" /></button>
        )}

        {hasNodes && <TransformControls nodes={selectedNodes} />}

        {/* opacity — applies to every node type */}
        {hasNodes && (
          <OpacityControl
            value={selectedNodes[0]?.opacity ?? 1}
            onChange={(v) => patch({ opacity: v })}
          />
        )}

        {hasNodes && <ArrangeControls />}

        <Dropdown
          align="right"
          trigger={(open) => (
            <span
              className={cn(
                "grid h-8 w-8 cursor-pointer place-items-center rounded-lg text-white/60 transition hover:bg-white/[0.08] hover:text-white",
                open && "bg-white/[0.08] text-white"
              )}
              aria-label="More"
              title="More"
            >
              <MoreHorizontal className="h-4 w-4" />
            </span>
          )}
        >
          {(close) => (
            <>
              <MenuItem
                onClick={() => {
                  bringToFront();
                  close();
                }}
              >
                <BringToFront className="h-4 w-4 text-white/45" /> Bring to front
              </MenuItem>
              <MenuItem
                onClick={() => {
                  sendToBack();
                  close();
                }}
              >
                <SendToBack className="h-4 w-4 text-white/45" /> Send to back
              </MenuItem>
              {hasNodes && (
                <>
                  <div className="my-1 h-px bg-line" />
                  <LockMenuItems onDone={close} />
                </>
              )}
              <div className="my-1 h-px bg-line" />
              <MenuItem
                onClick={() => {
                  duplicateSelected();
                  close();
                }}
              >
                <Copy className="h-4 w-4 text-white/45" /> Duplicate
                <span className="ml-auto text-xs text-white/40">⌘D</span>
              </MenuItem>
              <MenuItem
                onClick={() => {
                  deleteSelected();
                  close();
                }}
              >
                <Trash2 className="h-4 w-4 text-red-400/80" />
                <span className="text-red-300/90">Delete</span>
              </MenuItem>
            </>
          )}
        </Dropdown>
      </div>
    </div>
  );
}

function ColorSwatchButton({
  label,
  value,
  onChange,
}

) {
  const [custom, setCustom] = useState(value);
  return (
    <Dropdown
      trigger={(open) => (
        <span
          className={cn(
            "grid h-8 w-8 cursor-pointer place-items-center rounded-lg ring-1 ring-line transition hover:ring-lineStrong",
            open && "ring-brand/50"
          )}
          aria-label={label}
          title={label}
        >
          <span
            className="h-4 w-4 rounded-full border border-white/30"
            style={
              value === "transparent"
                ? {
                    backgroundImage: "repeating-conic-gradient(#666 0% 25%, #333 0% 50%)",
                    backgroundSize: "6px 6px",
                  }
                : { backgroundColor: value }
            }
          />
        </span>
      )}
    >
      {(close) => (
        <div className="w-44">
          <div className="grid grid-cols-4 gap-1.5 p-1">
            {PALETTE.map((sw) => (
              <button
                key={sw.value}
                type="button"
                role="button"
                aria-label={sw.name}
                title={sw.name}
                onClick={() => {
                  onChange(sw.value);
                  close();
                }}
                className="relative grid h-8 w-8 place-items-center rounded-md border border-white/15"
                style={
                  sw.value === "transparent"
                    ? {
                        backgroundImage: "repeating-conic-gradient(#666 0% 25%, #333 0% 50%)",
                        backgroundSize: "6px 6px",
                      }
                    : { backgroundColor: sw.value }
                }
              >
                {value === sw.value && (
                  <Check className="h-3.5 w-3.5 text-white drop-shadow" />
                )}
              </button>
            ))}
          </div>
          <div className="mt-1 flex items-center gap-1.5 border-t border-line p-1.5">
            <input
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  onChange(custom);
                  close();
                }
              }}
              placeholder="#rrggbb"
              className="h-7 flex-1 rounded-md border border-line bg-ink-800 px-2 text-xs text-white outline-none placeholder:text-white/30 focus:border-brand/40"
            />
            <button
              type="button"
              onClick={() => {
                onChange(custom);
                close();
              }}
              className="rounded-md bg-brand/20 px-2 py-1 text-xs font-semibold text-brand hover:bg-brand/30"
            >
              Use
            </button>
          </div>
        </div>
      )}
    </Dropdown>
  );
}

function StrokeWidthControl({ value, onChange }) {
  const OPTIONS = [1, 2, 4];
  return (
    <div className="flex items-center gap-0.5 rounded-lg bg-ink-800 p-0.5">
      {OPTIONS.map((w) => (
        <button
          key={w}
          type="button"
          aria-label={`Stroke width ${w}`}
          title={`Stroke width ${w}px`}
          onClick={() => onChange(w)}
          className={cn(
            "grid h-7 w-7 place-items-center rounded-md text-[11px] font-medium transition",
            value === w ? "bg-ink-600 text-white ring-1 ring-line" : "text-white/50 hover:text-white"
          )}
        >
          {w === 1 ? "S" : w === 2 ? "M" : "L"}
        </button>
      ))}
    </div>
  );
}

function ArrowheadControl({ kind, onChange }) {
  return (
    <div className="flex items-center gap-0.5 rounded-lg bg-ink-800 p-0.5">
      <button
        type="button"
        aria-label="No arrowhead"
        title="No arrowhead"
        onClick={() => onChange("line")}
        className={cn(
          "grid h-7 w-7 place-items-center rounded-md transition",
          kind === "line" ? "bg-ink-600 text-white ring-1 ring-line" : "text-white/50 hover:text-white"
        )}
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label="Arrow"
        title="Arrow"
        onClick={() => onChange("arrow")}
        className={cn(
          "grid h-7 w-7 place-items-center rounded-md text-[11px] font-medium transition",
          kind === "arrow" ? "bg-ink-600 text-white ring-1 ring-line" : "text-white/50 hover:text-white"
        )}
      >
        →
      </button>
    </div>
  );
}

function CornerRadiusControl({ value, onChange }) {
  return (
    <div className="flex items-center gap-0.5 rounded-lg bg-ink-800 p-0.5">
      <button
        type="button"
        aria-label="Sharp corners"
        title="Sharp corners"
        onClick={() => onChange(0)}
        className={cn(
          "grid h-7 w-7 place-items-center rounded-md transition",
          value === 0 ? "bg-ink-600 text-white ring-1 ring-line" : "text-white/50 hover:text-white"
        )}
      >
        <Square className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label="Rounded corners"
        title="Rounded corners"
        onClick={() => onChange(12)}
        className={cn(
          "grid h-7 w-7 place-items-center rounded-md transition",
          value > 0 ? "bg-ink-600 text-white ring-1 ring-line" : "text-white/50 hover:text-white"
        )}
      >
        <Square className="h-3.5 w-3.5 rounded-[3px]" />
      </button>
    </div>
  );
}

function FontSizeControl({ value, onChange }) {
  return (
    <div className="flex items-center gap-0.5 rounded-lg bg-ink-800 px-1">
      <button
        type="button"
        aria-label="Decrease font size"
        onClick={() => onChange(Math.max(12, value - 2))}
        className="grid h-7 w-5 place-items-center text-white/55 hover:text-white"
      >
        −
      </button>
      <span className="w-6 text-center text-xs tabular-nums text-white/80">{value}</span>
      <button
        type="button"
        aria-label="Increase font size"
        onClick={() => onChange(Math.min(96, value + 2))}
        className="grid h-7 w-5 place-items-center text-white/55 hover:text-white"
      >
        +
      </button>
    </div>
  );
}

function TextAlignControl({
  value,
  onChange,
}

) {
  const OPTIONS = [
    { id: "left", icon: AlignLeft },
    { id: "center", icon: AlignCenter },
    { id: "right", icon: AlignRight },
  ];
  return (
    <div className="flex items-center gap-0.5 rounded-lg bg-ink-800 p-0.5">
      {OPTIONS.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-label={`Align ${o.id}`}
          title={`Align ${o.id}`}
          onClick={() => onChange(o.id)}
          className={cn(
            "grid h-7 w-7 place-items-center rounded-md transition",
            value === o.id ? "bg-ink-600 text-white ring-1 ring-line" : "text-white/50 hover:text-white"
          )}
        >
          <o.icon className="h-3.5 w-3.5" />
        </button>
      ))}
    </div>
  );
}

function OpacityControl({ value, onChange }) {
  return (
    <div className="flex items-center gap-1.5 px-1">
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.round(value * 100)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        className="h-1.5 w-16 cursor-pointer accent-white"
        aria-label="Opacity"
        title={`Opacity: ${Math.round(value * 100)}%`}
      />
      <span className="w-8 text-right text-[11px] tabular-nums text-white/50">
        {Math.round(value * 100)}%
      </span>
    </div>
  );
}

const FORMAT_BUTTONS = [
  { kind: "b", icon: Bold, label: "Bold", shortcut: "⌘B" },
  { kind: "i", icon: Italic, label: "Italic", shortcut: "⌘I" },
  { kind: "u", icon: Underline, label: "Underline", shortcut: "⌘U" },
  { kind: "s", icon: Strikethrough, label: "Strikethrough", shortcut: "⌘⇧X" },
];

/** Keeps focus (and the text selection) in the open editor. */
function keepEditorFocus(e) {
  e.preventDefault();
}

/**
 * Bold, italic, underline, strikethrough, highlight and link for the text
 * selection inside the open editor. Buttons never take focus; the link field
 * does, so it is marked `data-rich-format` and the editor stays open while
 * it is in use, then restores the saved selection to apply the link.
 */
function TextFormatControls({ popoverBelow }) {
  const [formats, setFormats] = useState({});
  const [panel, setPanel] = useState(null);
  const [linkDraft, setLinkDraft] = useState("");
  const [savedSelection, setSavedSelection] = useState(null);
  const [hadLink, setHadLink] = useState(false);
  // Popovers open away from the node so they never cover the text being edited.
  const popoverSide = popoverBelow ? "top-full mt-2" : "bottom-full mb-2";

  useEffect(() => {
    const update = () => setFormats(activeFormats());
    update();
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, []);

  const openLink = () => {
    const saved = saveSelection();
    if (!saved) return;
    setSavedSelection(saved);
    const existing = activeFormats().a ?? "";
    setLinkDraft(existing);
    setHadLink(!!existing);
    setPanel("link");
  };

  useEffect(() => onLinkRequest(openLink));

  const run = (action) => {
    action();
    setFormats(activeFormats());
  };

  const closeLink = () => {
    setPanel(null);
    restoreSelection(savedSelection);
  };

  const submitLink = () => {
    const href = normalizeHref(linkDraft);
    setPanel(null);
    run(() => applyLink(savedSelection, href));
  };

  return (
    <div data-rich-format="" role="group" aria-label="Text formatting" className="relative flex items-center gap-0.5 rounded-lg bg-ink-800 p-0.5">
      {FORMAT_BUTTONS.map(({ kind, icon: Icon, label, shortcut }) => (
        <button
          key={kind}
          type="button"
          aria-label={label}
          aria-pressed={!!formats[kind]}
          title={`${label} (${shortcut})`}
          onMouseDown={keepEditorFocus}
          onClick={() => run(() => toggleFormat(kind))}
          className={cn(
            "grid h-7 w-7 place-items-center rounded-md transition",
            formats[kind] ? "bg-ink-600 text-white ring-1 ring-line" : "text-white/55 hover:text-white"
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      ))}
      <button
        type="button"
        aria-label="Highlight"
        aria-pressed={!!formats.h}
        aria-expanded={panel === "highlight"}
        title="Highlight"
        onMouseDown={keepEditorFocus}
        onClick={() => setPanel(panel === "highlight" ? null : "highlight")}
        className={cn(
          "grid h-7 w-7 place-items-center rounded-md transition",
          formats.h || panel === "highlight" ? "bg-ink-600 text-white ring-1 ring-line" : "text-white/55 hover:text-white"
        )}
      >
        <Highlighter className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label="Link"
        aria-pressed={!!formats.a}
        aria-expanded={panel === "link"}
        title="Link (⌘K)"
        onMouseDown={keepEditorFocus}
        onClick={() => (panel === "link" ? closeLink() : openLink())}
        className={cn(
          "grid h-7 w-7 place-items-center rounded-md transition",
          formats.a || panel === "link" ? "bg-ink-600 text-white ring-1 ring-line" : "text-white/55 hover:text-white"
        )}
      >
        <Link2 className="h-3.5 w-3.5" />
      </button>

      {panel === "highlight" && (
        <div
          role="group"
          aria-label="Highlight colors"
          className={cn("absolute left-0 flex items-center gap-1 rounded-xl border border-line bg-ink-750/95 p-1.5 shadow-pop backdrop-blur-xl", popoverSide)}
        >
          {HIGHLIGHT_COLORS.map((color) => (
            <button
              key={color.value}
              type="button"
              aria-label={`${color.name} highlight`}
              title={color.name}
              onMouseDown={keepEditorFocus}
              onClick={() => {
                setPanel(null);
                run(() => applyHighlight(color.value));
              }}
              className="relative grid h-6 w-6 place-items-center rounded-md border border-white/15"
              style={{ backgroundColor: color.value }}
            >
              {formats.h === color.value && <Check className="h-3 w-3 text-ink-900" />}
            </button>
          ))}
          <button
            type="button"
            aria-label="Remove highlight"
            title="Remove highlight"
            onMouseDown={keepEditorFocus}
            onClick={() => {
              setPanel(null);
              run(() => applyHighlight(null));
            }}
            className="grid h-6 w-6 place-items-center rounded-md border border-white/15 text-white/60 hover:text-white"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {panel === "link" && (
        <form
          className={cn("absolute left-0 flex items-center gap-1.5 rounded-xl border border-line bg-ink-750/95 p-1.5 shadow-pop backdrop-blur-xl", popoverSide)}
          onSubmit={(e) => {
            e.preventDefault();
            submitLink();
          }}
        >
          <input
            autoFocus
            value={linkDraft}
            onChange={(e) => setLinkDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                closeLink();
              }
            }}
            aria-label="Link address"
            placeholder="https://"
            className="h-7 w-56 rounded-md border border-line bg-ink-800 px-2 text-xs text-white outline-none placeholder:text-white/30 focus:border-brand/40"
          />
          <button
            type="submit"
            disabled={!linkDraft.trim() && !hadLink}
            className="rounded-md bg-brand/20 px-2 py-1 text-xs font-semibold text-brand hover:bg-brand/30 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-brand/20"
          >
            {linkDraft.trim() || !hadLink ? "Apply" : "Remove link"}
          </button>
        </form>
      )}
    </div>
  );
}
