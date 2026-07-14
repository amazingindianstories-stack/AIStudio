"use client";

import { useState } from "react";
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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useCanvasStore, type NodeStyleProps } from "@/lib/canvas-store";
import { nodeBounds, resolveEndpoint, worldToScreen } from "@/lib/canvas/geometry";
import { Dropdown, MenuItem } from "@/components/Dropdown";
import type { CanvasNode } from "@/lib/canvas/types";

// ~12 monochrome-plus-FigJam-ish swatches — the only saturated color in the
// board's chrome, and it only ever comes from user choice (ui-spec §5).
const PALETTE: { value: string; name: string }[] = [
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

export function StyleInspector({ hidden }: { hidden: boolean }) {
  const selection = useCanvasStore((s) => s.selection);
  const selectedConnectorIds = useCanvasStore((s) => s.selectedConnectorIds);
  const present = useCanvasStore((s) => s.history.present);
  const updateSelectedStyle = useCanvasStore((s) => s.updateSelectedStyle);
  const bringToFront = useCanvasStore((s) => s.bringToFront);
  const sendToBack = useCanvasStore((s) => s.sendToBack);
  const duplicateSelected = useCanvasStore((s) => s.duplicateSelected);
  const deleteSelected = useCanvasStore((s) => s.deleteSelected);

  const selectedNodes = present.nodes.filter((n) => selection.includes(n.id));
  const selectedConnectors = present.connectors.filter((c) => selectedConnectorIds.includes(c.id));

  const hasNodes = selectedNodes.length > 0;
  const hasConnectors = selectedConnectors.length > 0;

  if (hidden || (!hasNodes && !hasConnectors)) return null;

  const viewport = present.viewport;
  const nodesById: Record<string, CanvasNode> = {};
  for (const n of present.nodes) nodesById[n.id] = n;

  // union world bounds of everything selected, for anchoring
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const n of selectedNodes) {
    const b = nodeBounds(n);
    bx0 = Math.min(bx0, b.x);
    by0 = Math.min(by0, b.y);
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

  const isShape = soleType === "rect" || soleType === "ellipse" || soleType === "triangle" || soleType === "diamond";
  const showFill = homogeneous && (isShape || soleType === "sticky" || soleType === "frame");
  const showStroke = homogeneous && isShape;
  const showCornerRadius = homogeneous && soleType === "rect";
  const showTextColor = homogeneous && (soleType === "text" || soleType === "sticky");
  const showFontSize = showTextColor;
  const showTextAlign = homogeneous && soleType === "text";
  const showFrameLabel = homogeneous && soleType === "frame";

  // `updateSelectedStyle` patches BOTH the node `selection` and
  // `selectedConnectorIds` in one call (see canvas-store.ts's
  // `NodeStyleProps`/`applyStylePatchToConnector`), so a connector-only
  // selection is patched through the same call.
  const patch = (p: Partial<NodeStyleProps>) => updateSelectedStyle(p);

  return (
    <div
      className="absolute z-40 flex h-11 items-center gap-1 rounded-2xl border border-line bg-ink-750/95 p-1 shadow-pop backdrop-blur-xl"
      style={{ left: centerX, top, transform: "translateX(-50%)" }}
    >
      {showFill && (
        <ColorSwatchButton
          label="Fill"
          value={(selectedNodes[0] as any).fill ?? "transparent"}
          onChange={(v) => patch({ fill: v })}
        />
      )}

      {(showStroke || onlyConnectors) && (
        <>
          <ColorSwatchButton
            label="Stroke color"
            value={onlyConnectors ? selectedConnectors[0]?.stroke ?? "#ffffff" : (selectedNodes[0] as any).stroke}
            onChange={(v) => patch({ stroke: v })}
          />
          <StrokeWidthControl
            value={onlyConnectors ? selectedConnectors[0]?.strokeWidth ?? 2 : (selectedNodes[0] as any).strokeWidth ?? 2}
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
          value={(selectedNodes[0] as any).cornerRadius ?? 0}
          onChange={(v) => patch({ cornerRadius: v })}
        />
      )}

      {showTextColor && (
        <ColorSwatchButton
          label="Text color"
          value={(selectedNodes[0] as any).color ?? "#ffffff"}
          onChange={(v) => patch({ color: v })}
        />
      )}

      {showFontSize && (
        <FontSizeControl
          value={(selectedNodes[0] as any).fontSize ?? 16}
          onChange={(v) => patch({ fontSize: v })}
        />
      )}

      {showTextAlign && (
        <TextAlignControl
          value={(selectedNodes[0] as any).align ?? "left"}
          onChange={(v) => patch({ align: v })}
        />
      )}

      {showFrameLabel && (
        <input
          defaultValue={(selectedNodes[0] as any).name ?? ""}
          onBlur={(e) => patch({ name: e.currentTarget.value })}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          placeholder="Frame label"
          className="h-8 w-32 rounded-lg border border-line bg-ink-800 px-2 text-xs text-white outline-none placeholder:text-white/30 focus:border-brand/40"
        />
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
  );
}

function ColorSwatchButton({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
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

function StrokeWidthControl({ value, onChange }: { value: number; onChange: (v: number) => void }) {
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

function ArrowheadControl({ kind, onChange }: { kind: "line" | "arrow"; onChange: (k: "line" | "arrow") => void }) {
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

function CornerRadiusControl({ value, onChange }: { value: number; onChange: (v: number) => void }) {
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

function FontSizeControl({ value, onChange }: { value: number; onChange: (v: number) => void }) {
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
}: {
  value: "left" | "center" | "right";
  onChange: (v: "left" | "center" | "right") => void;
}) {
  const OPTIONS: { id: "left" | "center" | "right"; icon: typeof AlignLeft }[] = [
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

function OpacityControl({ value, onChange }: { value: number; onChange: (v: number) => void }) {
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
