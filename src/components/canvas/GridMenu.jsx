"use client";

import { useState } from "react";
import { Table2 } from "lucide-react";
import { Dropdown } from "@/components/Dropdown";
import { addEmptyGrid, addGridFromText } from "@/lib/grid-actions";
import { MAX_GRID_CELLS } from "@/lib/canvas/grid";

/** Toolbar entry for the grid widget: an empty table of a chosen size, or one made from pasted CSV or TSV text. */
export function GridMenu() {
  const [rows, setRows] = useState(4);
  const [cols, setCols] = useState(4);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState("");

  return (
    <Dropdown
      side="top"
      label="Grid"
      panelClassName="min-w-0"
      trigger={(open) => (
        <span
          title="Grid"
          className={"grid h-9 w-9 place-items-center rounded-lg text-white/55 transition-colors hover:bg-white/[0.07] hover:text-white max-sm:h-8 max-sm:w-8 " + (open ? "bg-white/[0.07]" : "")}
        >
          <Table2 className="h-4 w-4" />
        </span>
      )}
    >
      {(close) => (
        <div className="w-[260px] space-y-2 p-1 text-xs text-white/80" onPointerDown={(e) => e.stopPropagation()}>
          <p className="px-0.5 text-[11px] font-medium uppercase tracking-wide text-white/40">Grid</p>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1">Rows
              <input type="number" min={1} max={100} value={rows} onChange={(e) => setRows(Number(e.target.value))} className="w-14 rounded bg-ink-700 px-1.5 py-1 text-white outline-none ring-1 ring-line focus:ring-brand" />
            </label>
            <label className="flex items-center gap-1">Columns
              <input type="number" min={1} max={100} value={cols} onChange={(e) => setCols(Number(e.target.value))} className="w-14 rounded bg-ink-700 px-1.5 py-1 text-white outline-none ring-1 ring-line focus:ring-brand" />
            </label>
          </div>
          <button
            type="button"
            className="w-full rounded-md bg-brand/90 px-2 py-1.5 font-medium text-ink-900 hover:bg-brand"
            onClick={() => {
              addEmptyGrid(rows, cols);
              close({ restoreFocus: false });
            }}
          >
            Add empty grid
          </button>
          <p className="pt-1 text-[11px] text-white/50">Or paste cells copied from Excel or Google Sheets (CSV or TSV, up to {MAX_GRID_CELLS.toLocaleString("en-US")} cells).</p>
          <textarea
            aria-label="Paste table text"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setProblem("");
            }}
            rows={4}
            className="w-full resize-none rounded bg-ink-700 p-1.5 text-white outline-none ring-1 ring-line focus:ring-brand"
          />
          {problem && <p role="alert" className="text-[11px] text-red-300">{problem}</p>}
          <button
            type="button"
            className="w-full rounded-md bg-ink-600 px-2 py-1.5 font-medium text-white ring-1 ring-line hover:bg-ink-500"
            onClick={() => {
              if (addGridFromText(text)) {
                setText("");
                close({ restoreFocus: false });
              } else setProblem("No table found in that text.");
            }}
          >
            Create grid from text
          </button>
        </div>
      )}
    </Dropdown>
  );
}
