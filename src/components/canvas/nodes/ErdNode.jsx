"use client";

import { Plus, Trash2 } from "lucide-react";
import { useCanvasStore } from "@/lib/canvas-store";
import { strokeDasharrayFor } from "./ShapeNode";

const HEADER_H = 36;
const ROW_H = 28;

export function ErdNode({ node, selected, hovered, readOnly, onAnchorDown }) {
  const updateNodeFields = useCanvasStore((s) => s.updateNodeFields);
  const columns = node.columns ?? 3;
  const rows = Array.isArray(node.rows) ? node.rows : [];
  const dash = strokeDasharrayFor(node.strokeStyle, node.strokeWidth);
  const showHandles = !readOnly && (selected || hovered);

  const updateCell = (rowIndex, cellIndex, value) => {
    if (readOnly) return;
    const nextRows = rows.map((r, idx) => {
      if (idx !== rowIndex) return r;
      const cells = [...(r.cells || ["", "", ""])];
      cells[cellIndex] = value;
      return { ...r, cells };
    });
    updateNodeFields(node.id, { rows: nextRows });
  };

  const addRow = (e) => {
    e.stopPropagation();
    if (readOnly) return;
    const newRow = {
      id: `row-${crypto.randomUUID().slice(0, 8)}`,
      cells: columns === 1 ? ["field_name"] : columns === 2 ? ["field_name", "varchar"] : ["", "field_name", "varchar"],
    };
    const nextRows = [...rows, newRow];
    const minH = HEADER_H + nextRows.length * ROW_H + 34;
    updateNodeFields(node.id, {
      rows: nextRows,
      h: Math.max(node.h, minH),
    });
  };

  const removeRow = (e, rowIndex) => {
    e.stopPropagation();
    if (readOnly || rows.length <= 1) return;
    const nextRows = rows.filter((_, idx) => idx !== rowIndex);
    updateNodeFields(node.id, { rows: nextRows });
  };

  const cycleColumns = (e) => {
    e.stopPropagation();
    if (readOnly) return;
    const nextCols = columns === 3 ? 1 : columns + 1;
    updateNodeFields(node.id, { columns: nextCols });
  };

  return (
    <div
      data-erd-node={node.id}
      className="relative flex h-full w-full flex-col overflow-visible rounded-md select-none"
      style={{
        backgroundColor: node.fill || "#18181b",
        border: `${node.strokeWidth ?? 2}px ${node.strokeStyle || "solid"} ${node.stroke || "#6366f1"}`,
        color: node.color || "#f4f4f5",
        strokeDasharray: dash,
      }}
    >
      {/* Entity Header */}
      <div
        className="flex items-center justify-between px-3 font-semibold text-xs tracking-wide border-b"
        style={{
          height: HEADER_H,
          minHeight: HEADER_H,
          backgroundColor: node.headerFill || "rgba(99, 102, 241, 0.28)",
          borderColor: node.stroke || "#6366f1",
        }}
      >
        {selected && !readOnly ? (
          <input
            type="text"
            aria-label="Entity name"
            value={node.name ?? "Entity"}
            onChange={(e) => updateNodeFields(node.id, { name: e.target.value })}
            onPointerDown={(e) => e.stopPropagation()}
            className="w-full bg-transparent font-semibold text-xs outline-none"
          />
        ) : (
          <span className="truncate">{node.name || "Entity"}</span>
        )}
        {selected && !readOnly && (
          <button
            type="button"
            onClick={cycleColumns}
            onPointerDown={(e) => e.stopPropagation()}
            title="Switch attribute column count (1, 2, or 3)"
            className="ml-2 shrink-0 rounded bg-black/30 px-1.5 py-0.5 text-[10px] font-medium text-zinc-200 hover:bg-black/50"
          >
            {columns} col{columns > 1 ? "s" : ""}
          </button>
        )}
      </div>

      {/* Attribute Rows */}
      <div className="flex flex-1 flex-col divide-y divide-white/10">
        {rows.map((row, rowIdx) => {
          const cells = row.cells || ["", "", ""];
          const leftAnchor = `row:${row.id}:left`;
          const rightAnchor = `row:${row.id}:right`;
          return (
            <div
              key={row.id || rowIdx}
              data-erd-row={row.id}
              className="group relative flex items-center text-[11px]"
              style={{ height: ROW_H, minHeight: ROW_H }}
            >
              {showHandles && onAnchorDown && (
                <button
                  type="button"
                  aria-label={`Connect from ${cells[1] || cells[0] || `row ${rowIdx + 1}`} left`}
                  onPointerDown={(e) => onAnchorDown(e, leftAnchor)}
                  className="pointer-events-auto absolute -left-2.5 top-1/2 z-10 h-2.5 w-2.5 -translate-y-1/2 rounded-full border border-white bg-indigo-500 shadow hover:scale-125"
                />
              )}

              {columns === 3 && (
                <div className="w-10 shrink-0 border-r border-white/10 px-1.5 font-mono text-[10px] text-amber-300">
                  {selected && !readOnly ? (
                    <input
                      type="text"
                      aria-label={`Row ${rowIdx + 1} key`}
                      value={cells[0] ?? ""}
                      placeholder="PK"
                      onChange={(e) => updateCell(rowIdx, 0, e.target.value)}
                      onPointerDown={(e) => e.stopPropagation()}
                      className="w-full bg-transparent outline-none placeholder:text-zinc-600"
                    />
                  ) : (
                    <span className="truncate">{cells[0]}</span>
                  )}
                </div>
              )}

              <div className="flex-1 px-2 font-medium truncate">
                {selected && !readOnly ? (
                  <input
                    type="text"
                    aria-label={`Row ${rowIdx + 1} attribute`}
                    value={cells[columns === 3 ? 1 : 0] ?? ""}
                    placeholder="attribute"
                    onChange={(e) => updateCell(rowIdx, columns === 3 ? 1 : 0, e.target.value)}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="w-full bg-transparent outline-none placeholder:text-zinc-600"
                  />
                ) : (
                  <span className="truncate">{cells[columns === 3 ? 1 : 0]}</span>
                )}
              </div>

              {columns >= 2 && (
                <div className="w-20 shrink-0 border-l border-white/10 px-2 font-mono text-[10px] text-zinc-400">
                  {selected && !readOnly ? (
                    <input
                      type="text"
                      aria-label={`Row ${rowIdx + 1} type`}
                      value={cells[columns === 3 ? 2 : 1] ?? ""}
                      placeholder="type"
                      onChange={(e) => updateCell(rowIdx, columns === 3 ? 2 : 1, e.target.value)}
                      onPointerDown={(e) => e.stopPropagation()}
                      className="w-full bg-transparent outline-none placeholder:text-zinc-600"
                    />
                  ) : (
                    <span className="truncate">{cells[columns === 3 ? 2 : 1]}</span>
                  )}
                </div>
              )}

              {selected && !readOnly && rows.length > 1 && (
                <button
                  type="button"
                  aria-label={`Remove row ${rowIdx + 1}`}
                  onClick={(e) => removeRow(e, rowIdx)}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="mr-1 rounded p-0.5 text-zinc-500 opacity-0 hover:bg-white/10 hover:text-rose-400 group-hover:opacity-100"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}

              {showHandles && onAnchorDown && (
                <button
                  type="button"
                  aria-label={`Connect from ${cells[1] || cells[0] || `row ${rowIdx + 1}`} right`}
                  onPointerDown={(e) => onAnchorDown(e, rightAnchor)}
                  className="pointer-events-auto absolute -right-2.5 top-1/2 z-10 h-2.5 w-2.5 -translate-y-1/2 rounded-full border border-white bg-indigo-500 shadow hover:scale-125"
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Add Row Footer */}
      {!readOnly && (
        <button
          type="button"
          aria-label="Add ERD attribute row"
          onClick={addRow}
          onPointerDown={(e) => e.stopPropagation()}
          className="flex h-7 items-center justify-center gap-1 border-t border-white/10 text-[11px] font-medium text-zinc-400 hover:bg-white/5 hover:text-white"
        >
          <Plus className="h-3 w-3" />
          <span>Add attribute</span>
        </button>
      )}
    </div>
  );
}
