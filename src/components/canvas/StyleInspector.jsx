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
import { isShapeNode } from "@/lib/canvas/shapes";
import { ColorPicker } from "./ColorPicker";
import { FontPicker } from "./FontPicker";
import { AutoFitButton, ReactionPicker, StickyShapeControl, TagPicker } from "./StickyControls";
import { StyleMoreItems } from "./StyleMoreItems";
import { STICKY_COLORS, stickyColorPatch } from "@/lib/canvas/stickies";
import { rememberSelectionStyle } from "@/lib/canvas/sticky-actions";
import { HIGHLIGHT_COLORS } from "@/lib/canvas/rich-text";
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

export function StyleInspector({ hidden }) {
  const selection = useCanvasStore((s) => s.selection);
  const selectedConnectorIds = useCanvasStore((s) => s.selectedConnectorIds);
  const present = useCanvasStore((s) => s.history.present);
  const updateSelectedStyle = useCanvasStore((s) => s.updateSelectedStyle);
  const bringToFront = useCanvasStore((s) => s.bringToFront);
  const sendToBack = useCanvasStore((s) => s.sendToBack);
  const duplicateSelected = useCanvasStore((s) => s.duplicateSelected);
  const deleteSelected = useCanvasStore((s) => s.deleteSelected);
  const beginCrop = useCanvasStore((s) => s.beginCrop);
  const insertShapeOnConnector = useCanvasStore((s) => s.insertShapeOnConnector);
  const upsertConnectorLabel = useCanvasStore((s) => s.upsertConnectorLabel);
  const removeConnectorLabel = useCanvasStore((s) => s.removeConnectorLabel);
  const updateConnectorWaypoints = useCanvasStore((s) => s.updateConnectorWaypoints);
  const convertSelectionToDiagram = useCanvasStore((s) => s.convertSelectionToDiagram);
  const editingTextId = useCanvasStore((s) => s.editingTextId);
  const panelRef = useRef(null);
  // Keep the panel inside its container on narrow screens: it is centred on the
  // selection, which can sit near either edge, so clamp after layout.
  useLayoutEffect(() => {
    const el = panelRef.current;
    const parent = el?.offsetParent;
    if (!el || !parent) return;
    const half = el.offsetWidth / 2;
    const desired = Number.parseFloat(el.dataset.centerX ?? "0");
    const left = Math.min(Math.max(desired, half + 8), Math.max(parent.clientWidth - half - 8, half + 8));
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
  const gap = 8;
  const panelHeight = 44;
  const flipBelow = topLeftScreen.y - panelHeight - gap < 8;
  const top = flipBelow ? bottomRightScreen.y + gap : topLeftScreen.y - panelHeight - gap;

  const types = new Set(selectedNodes.map((n) => n.type));
  const homogeneous = types.size <= 1;
  const soleType = homogeneous ? selectedNodes[0]?.type : undefined;
  const onlyConnectors = hasConnectors && !hasNodes;

  const isShape = selectedNodes.length > 0 && selectedNodes.every(isShapeNode);
  const isStructured =
    homogeneous && (soleType === "erd" || soleType === "swimlane" || soleType === "diagram");
  const showFill =
    isShape || isStructured || (homogeneous && (soleType === "sticky" || soleType === "stack" || soleType === "frame"));
  const showStroke = isShape || isStructured;
  const showCornerRadius = homogeneous && soleType === "rect";
  const shapeText = isShape && selectedNodes.every((n) => n.text || n.id === editingTextId);
  const showTextColor = shapeText || (homogeneous && (soleType === "text" || soleType === "sticky"));
  const showFontSize = showTextColor;
  const showTextAlign = shapeText || (homogeneous && soleType === "text");
  const showFrameLabel = homogeneous && soleType === "frame";
  const parentDiagram =
    hasNodes && selectedNodes[0]?.parentId && nodesById[selectedNodes[0].parentId]?.type === "diagram"
      ? nodesById[selectedNodes[0].parentId]
      : null;

  // `updateSelectedStyle` patches BOTH the node `selection` and
  // `selectedConnectorIds` in one call (see canvas-store.ts's
  // `NodeStyleProps`/`applyStylePatchToConnector`), so a connector-only
  // selection is patched through the same call.
  // New objects of the same kinds take the style chosen here (personal, per browser).
  const patch = (p) => {
    updateSelectedStyle(p);
    rememberSelectionStyle(selectedNodes, p);
  };
  const stickies = homogeneous && soleType === "sticky" ? selectedNodes : [];
  const autoFit = stickies.length > 0 && stickies.every((n) => n.autoFit);
  const editingRichText =
    selection.length === 1 && editingTextId === selection[0] && (RICH_TEXT_TYPES.has(soleType) || isShape);

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
            palette={stickies.length || soleType === "stack" ? STICKY_COLORS : undefined}
            onChange={(v) => patch(stickies.length ? stickyColorPatch(stickies[0], v) : { fill: v })}
          />
        )}

        {stickies.length > 0 && <StickyShapeControl stickies={stickies} />}

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
            <StrokeStyleControl
              value={
                onlyConnectors
                  ? selectedConnectors[0]?.strokeStyle ?? "solid"
                  : selectedNodes[0]?.strokeStyle ?? "solid"
              }
              onChange={(v) => patch({ strokeStyle: v })}
            />
          </>
        )}

        {onlyConnectors && (
          <>
            <ConnectorShapeControl
              value={selectedConnectors[0]?.shape ?? "curved"}
              onChange={(shape) => patch({ shape })}
            />
            <ArrowheadControl
              kind={selectedConnectors[0]?.kind ?? "arrow"}
              onChange={(kind) => patch({ kind })}
            />
            <CapPickerDropdown
              label="Start cap"
              value={selectedConnectors[0]?.startCap ?? "none"}
              onChange={(startCap) => patch({ startCap })}
            />
            <CapPickerDropdown
              label="End cap"
              value={
                selectedConnectors[0]?.endCap ??
                (selectedConnectors[0]?.kind === "arrow" ? "arrow" : "none")
              }
              onChange={(endCap) => patch({ endCap })}
            />
            {selectedConnectors.length === 1 && (
              <SingleConnectorActions
                connector={selectedConnectors[0]}
                onAddOrUpdateLabel={(label) => upsertConnectorLabel(selectedConnectors[0].id, label)}
                onRemoveLabel={(labelId) => removeConnectorLabel(selectedConnectors[0].id, labelId)}
                onInsertShape={() => insertShapeOnConnector(selectedConnectors[0].id, "rect")}
                onResetWaypoints={() => updateConnectorWaypoints(selectedConnectors[0].id, [])}
              />
            )}
          </>
        )}

        {parentDiagram && Array.isArray(parentDiagram.layers) && parentDiagram.layers.length > 0 && (
          <select
            aria-label="Diagram topic layer"
            value={selectedNodes[0]?.diagramLayerId || parentDiagram.layers[0]?.id || ""}
            onChange={(e) => patch({ diagramLayerId: e.target.value })}
            className="h-7 rounded-lg border border-line bg-ink-800 px-1.5 text-[11px] text-white outline-none"
          >
            {parentDiagram.layers.map((layer) => (
              <option key={layer.id} value={layer.id}>
                {layer.name}
              </option>
            ))}
          </select>
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

        {showTextColor && (
          <FontPicker value={selectedNodes[0]?.fontFamily ?? null} onChange={(fontFamily) => patch({ fontFamily })} />
        )}

        {showFontSize && (
          <FontSizeControl
            value={(selectedNodes[0] ).fontSize ?? 16}
            auto={autoFit}
            onChange={(v) => patch({ fontSize: v })}
          />
        )}

        {stickies.length > 0 && <AutoFitButton on={autoFit} onChange={(on) => patch({ autoFit: on })} />}

        {stickies.length > 0 && (
          <>
            <TagPicker stickies={stickies} />
            <ReactionPicker stickies={stickies} />
          </>
        )}

        {showTextAlign && (
          <TextAlignControl
            value={selectedNodes[0].align ?? (isShape ? "center" : "left")}
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

        {/* opacity — applies to every node type */}
        {hasNodes && (
          <OpacityControl
            value={selectedNodes[0]?.opacity ?? 1}
            onChange={(v) => patch({ opacity: v })}
          />
        )}

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
              {hasNodes && <StyleMoreItems nodes={selectedNodes} readOnly={false} close={close} />}
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
              {hasNodes && soleType !== "diagram" && (
                <MenuItem
                  onClick={() => {
                    convertSelectionToDiagram();
                    close();
                  }}
                >
                  <Square className="h-4 w-4 text-white/45" /> Convert to diagram
                </MenuItem>
              )}
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

function ColorSwatchButton({ label, value, palette, onChange }) {
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
        <ColorPicker
          value={value}
          palette={palette}
          onPick={(color) => {
            onChange(color);
            close();
          }}
        />
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

function StrokeStyleControl({ value = "solid", onChange }) {
  const OPTIONS = [
    { id: "solid", label: "Solid border", glyph: "───" },
    { id: "dashed", label: "Dashed border", glyph: "- - -" },
    { id: "dotted", label: "Dotted border", glyph: "· · ·" },
  ];
  return (
    <div className="flex items-center gap-0.5 rounded-lg bg-ink-800 p-0.5">
      {OPTIONS.map((opt) => (
        <button
          key={opt.id}
          type="button"
          aria-label={opt.label}
          title={opt.label}
          onClick={() => onChange(opt.id)}
          className={cn(
            "grid h-7 w-8 place-items-center rounded-md text-[10px] font-mono transition",
            value === opt.id ? "bg-ink-600 text-white ring-1 ring-line" : "text-white/50 hover:text-white"
          )}
        >
          {opt.glyph}
        </button>
      ))}
    </div>
  );
}

function ConnectorShapeControl({ value = "curved", onChange }) {
  const OPTIONS = [
    { id: "curved", label: "Curved line", text: "Curve" },
    { id: "orthogonal", label: "Orthogonal line", text: "Elbow" },
    { id: "straight", label: "Straight line", text: "Straight" },
  ];
  return (
    <div className="flex items-center gap-0.5 rounded-lg bg-ink-800 p-0.5">
      {OPTIONS.map((opt) => (
        <button
          key={opt.id}
          type="button"
          aria-label={opt.label}
          title={opt.label}
          onClick={() => onChange(opt.id)}
          className={cn(
            "h-7 rounded-md px-2 text-[10px] font-medium transition",
            value === opt.id ? "bg-ink-600 text-white ring-1 ring-line" : "text-white/50 hover:text-white"
          )}
        >
          {opt.text}
        </button>
      ))}
    </div>
  );
}

const CAP_OPTIONS = [
  { id: "none", label: "None" },
  { id: "arrow", label: "Filled arrow" },
  { id: "open-arrow", label: "Open arrow" },
  { id: "diamond", label: "Hollow diamond" },
  { id: "filled-diamond", label: "Filled diamond" },
  { id: "circle", label: "Circle" },
  { id: "erd-one", label: "ERD One (|)" },
  { id: "erd-only-one", label: "ERD Only one (||)" },
  { id: "erd-many", label: "ERD Many (<)" },
  { id: "erd-one-or-many", label: "ERD One or many (|<)" },
  { id: "erd-zero-or-one", label: "ERD Zero or one (o|)" },
  { id: "erd-zero-or-many", label: "ERD Zero or many (o<)" },
];

function CapPickerDropdown({ label, value = "none", onChange }) {
  return (
    <select
      aria-label={label}
      title={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-7 rounded-lg border border-line bg-ink-800 px-1.5 text-[10px] text-white outline-none"
    >
      {CAP_OPTIONS.map((cap) => (
        <option key={cap.id} value={cap.id}>
          {label.startsWith("Start") ? `Start: ${cap.label}` : `End: ${cap.label}`}
        </option>
      ))}
    </select>
  );
}

function SingleConnectorActions({
  connector,
  onAddOrUpdateLabel,
  onRemoveLabel,
  onInsertShape,
  onResetWaypoints,
}) {
  const labels = Array.isArray(connector.labels) ? connector.labels : [];
  const primary = labels[0] || null;
  const hasWaypoints = Array.isArray(connector.waypoints) && connector.waypoints.length > 0;

  return (
    <div className="flex items-center gap-1">
      {!primary ? (
        <button
          type="button"
          aria-label="Add line label"
          onClick={() =>
            onAddOrUpdateLabel({
              id: `lbl-${crypto.randomUUID().slice(0, 8)}`,
              text: "Label",
              position: 0.5,
              orientation: "horizontal",
            })
          }
          className="h-7 rounded-lg border border-line bg-ink-800 px-2 text-[10px] font-medium text-white/80 hover:bg-white/10 hover:text-white"
        >
          + Label
        </button>
      ) : (
        <div className="flex items-center gap-1 rounded-lg bg-ink-800 px-1.5 py-0.5">
          <input
            type="text"
            aria-label="Line label text"
            value={primary.text}
            onChange={(e) => onAddOrUpdateLabel({ ...primary, text: e.target.value })}
            placeholder="Label"
            className="h-6 w-20 bg-transparent text-xs text-white outline-none"
          />
          <button
            type="button"
            aria-label="Toggle line label orientation"
            title={primary.orientation === "aligned" ? "Aligned with line" : "Horizontal label"}
            onClick={() =>
              onAddOrUpdateLabel({
                ...primary,
                orientation: primary.orientation === "aligned" ? "horizontal" : "aligned",
              })
            }
            className="rounded bg-white/10 px-1.5 py-0.5 text-[9px] text-white/80 hover:bg-white/20"
          >
            {primary.orientation === "aligned" ? "Aligned" : "Horiz"}
          </button>
          <button
            type="button"
            aria-label="Add another line label"
            title="Add another label on this line"
            onClick={() =>
              onAddOrUpdateLabel({
                id: `lbl-${crypto.randomUUID().slice(0, 8)}`,
                text: `Label ${labels.length + 1}`,
                position: Math.min(0.85, 0.25 + labels.length * 0.25),
                orientation: "horizontal",
              })
            }
            className="rounded bg-white/10 px-1 py-0.5 text-[10px] text-white/80 hover:bg-white/20"
          >
            +
          </button>
          <button
            type="button"
            aria-label="Remove line label"
            onClick={() => onRemoveLabel(primary.id)}
            className="rounded p-0.5 text-white/50 hover:text-rose-400"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      <button
        type="button"
        aria-label="Insert shape on line"
        title="Insert shape on line and split connector"
        onClick={onInsertShape}
        className="h-7 rounded-lg border border-line bg-ink-800 px-2 text-[10px] font-medium text-white/80 hover:bg-white/10 hover:text-white"
      >
        + Shape on line
      </button>

      {hasWaypoints && (
        <button
          type="button"
          aria-label="Reset line path"
          title="Reset custom bend points"
          onClick={onResetWaypoints}
          className="h-7 rounded-lg border border-line bg-ink-800 px-2 text-[10px] font-medium text-white/70 hover:bg-white/10 hover:text-white"
        >
          Reset path
        </button>
      )}
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

function FontSizeControl({ value, auto = false, onChange }) {
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
      <span className={cn("min-w-6 text-center tabular-nums text-white/80", auto ? "text-[10px] font-medium" : "text-xs")}>{auto ? "Auto" : value}</span>
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
