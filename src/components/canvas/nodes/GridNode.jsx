"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Columns3, Combine, Rows3, Split, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { GRID_FILLS, gridOps } from "@/lib/grid-actions";
import { MAX_CELL_TEXT, normalizeRange, visibleCells } from "@/lib/canvas/grid";

/**
 * A table-like widget. Moving works from the strip above the table; once the grid is selected, a click picks a
 * cell (drag or shift-click for a range) and a double click edits it. The controls above the table add and
 * remove rows and columns, merge cells and set their colors.
 */
export function GridNode({ node, selected, readOnly }) {
  const [range, setRange] = useState(null);
  const [editing, setEditing] = useState(null);
  const dragRef = useRef(null);
  const cells = useMemo(() => visibleCells(node), [node]);
  const active = selected && !readOnly;

  useEffect(() => {
    if (!selected) {
      setRange(null);
      setEditing(null);
    }
  }, [selected]);

  const rowH = node.h / node.rows;
  const colW = node.w / node.cols;
  const normalized = range ? normalizeRange(range) : null;
  const anchor = normalized ?? { r0: 0, c0: 0, r1: 0, c1: 0 };

  const pick = (e, r, c) => {
    if (!active) return;
    e.stopPropagation();
    if (e.shiftKey && range) setRange({ ...range, r1: r, c1: c });
    else setRange({ r0: r, c0: c, r1: r, c1: c });
    setEditing(null);
    dragRef.current = true;
  };
  const extend = (r, c) => {
    if (dragRef.current && range && (range.r1 !== r || range.c1 !== c)) setRange({ ...range, r1: r, c1: c });
  };

  return (
    <div className="relative h-full w-full" data-grid-id={node.id} onPointerUp={() => { dragRef.current = null; }}>
      {active && (
        <div
          className="absolute -top-9 left-0 z-20 flex items-center gap-0.5 rounded-lg border border-line bg-ink-750/95 p-1 shadow-pop"
          onPointerDown={(e) => e.stopPropagation()}
          role="toolbar"
          aria-label="Grid controls"
        >
          <GridButton label="Add row below" onClick={() => gridOps.addRow(node.id, anchor.r1 + 1)}><Rows3 className="h-3.5 w-3.5" /></GridButton>
          <GridButton label="Add column right" onClick={() => gridOps.addColumn(node.id, anchor.c1 + 1)}><Columns3 className="h-3.5 w-3.5" /></GridButton>
          <GridButton label="Delete row" disabled={node.rows <= 1} onClick={() => gridOps.removeRow(node.id, anchor.r0)}><span className="text-[10px] font-semibold">Row</span><Trash2 className="h-3 w-3" /></GridButton>
          <GridButton label="Delete column" disabled={node.cols <= 1} onClick={() => gridOps.removeColumn(node.id, anchor.c0)}><span className="text-[10px] font-semibold">Col</span><Trash2 className="h-3 w-3" /></GridButton>
          <span className="mx-0.5 h-4 w-px bg-line" aria-hidden />
          <GridButton label="Merge cells" disabled={!normalized} onClick={() => normalized && gridOps.merge(node.id, normalized)}><Combine className="h-3.5 w-3.5" /></GridButton>
          <GridButton label="Unmerge cells" disabled={!normalized} onClick={() => normalized && gridOps.unmerge(node.id, normalized)}><Split className="h-3.5 w-3.5" /></GridButton>
          <span className="mx-0.5 h-4 w-px bg-line" aria-hidden />
          {GRID_FILLS.map((fill) => (
            <button
              key={fill}
              type="button"
              aria-label={`Cell color ${fill}`}
              disabled={!normalized}
              onClick={() => normalized && gridOps.fill(node.id, normalized, fill)}
              className="h-4 w-4 rounded-full border border-white/30 disabled:opacity-40"
              style={{ background: fill }}
            />
          ))}
          <button
            type="button"
            aria-label="Clear cell color"
            disabled={!normalized}
            onClick={() => normalized && gridOps.fill(node.id, normalized, null)}
            className="ml-0.5 rounded px-1 text-[10px] text-white/70 hover:bg-white/10 disabled:opacity-40"
          >
            Clear
          </button>
        </div>
      )}
      <div
        className="absolute inset-0 overflow-hidden rounded-sm border bg-ink-800/60"
        style={{
          borderColor: node.stroke,
          display: "grid",
          gridTemplateRows: `repeat(${node.rows}, ${rowH}px)`,
          gridTemplateColumns: `repeat(${node.cols}, ${colW}px)`,
        }}
      >
        {cells.map((cell) => {
          const inRange = normalized && cell.r >= normalized.r0 && cell.r <= normalized.r1 && cell.c >= normalized.c0 && cell.c <= normalized.c1;
          const isEditing = editing && editing.r === cell.r && editing.c === cell.c;
          return (
            <div
              key={`${cell.r},${cell.c}`}
              role="gridcell"
              data-cell={`${cell.r},${cell.c}`}
              onPointerDown={(e) => pick(e, cell.r, cell.c)}
              onPointerEnter={() => extend(cell.r, cell.c)}
              onDoubleClick={(e) => {
                if (!active) return;
                e.stopPropagation();
                setRange({ r0: cell.r, c0: cell.c, r1: cell.r, c1: cell.c });
                setEditing({ r: cell.r, c: cell.c });
              }}
              className={cn("relative overflow-hidden border border-white/15 px-1.5 py-1 text-xs leading-snug text-white/85", inRange && "outline outline-2 -outline-offset-2 outline-brand")}
              style={{ gridRow: `${cell.r + 1} / span ${cell.rs}`, gridColumn: `${cell.c + 1} / span ${cell.cs}`, background: cell.fill ?? undefined, color: cell.color ?? undefined }}
            >
              {isEditing ? (
                <CellEditor
                  initial={cell.text}
                  onCommit={(text) => {
                    setEditing(null);
                    if (text !== cell.text) gridOps.text(node.id, cell.r, cell.c, text);
                  }}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <span className="block whitespace-pre-wrap break-words">{cell.text}</span>
              )}
            </div>
          );
        })}
      </div>
      {active && (
        <div
          className="absolute -bottom-4 left-0 right-0 flex h-3 cursor-move items-center justify-center rounded-b bg-brand/30 text-[8px] uppercase tracking-wide text-white/70"
          title="Drag to move the grid"
          aria-label="Move grid"
        >
          Move
        </div>
      )}
    </div>
  );
}

function CellEditor({ initial, onCommit, onCancel }) {
  const ref = useRef(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <textarea
      ref={ref}
      defaultValue={initial}
      maxLength={MAX_CELL_TEXT}
      aria-label="Cell text"
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={(e) => onCommit(e.currentTarget.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        } else if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      className="absolute inset-0 h-full w-full resize-none select-text bg-ink-700 px-1.5 py-1 text-xs text-white outline-none"
    />
  );
}

function GridButton({ label, onClick, disabled, children }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-6 items-center gap-0.5 rounded px-1.5 text-white/75 hover:bg-white/10 hover:text-white disabled:opacity-40"
    >
      {children}
    </button>
  );
}
