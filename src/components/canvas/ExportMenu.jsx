"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { cn } from "@/lib/utils";
import { Dropdown, MenuItem } from "@/components/Dropdown";
import { useCanvasStore } from "@/lib/canvas-store";
import {
  IMAGE_SIZES,
  buildCsv,
  buildPdf,
  buildSvg,
  downloadBlob,
  downloadOriginals,
  downloadableImages,
  exportFileName,
  exportScope,
  printSvg,
  svgToJpeg,
} from "@/lib/canvas/board-export-run";

/**
 * Export menu beside the zoom control: the whole board or the selection
 * (a selected frame exports as that frame) as a JPG, SVG or text CSV, or
 * printed. Anyone who can open the board may export it.
 */
export function ExportMenu() {
  const selection = useCanvasStore((s) => s.selection);
  const [scopeKind, setScopeKind] = useState("board");
  const [status, setStatus] = useState("");
  const hasOriginals = useCanvasStore((s) => downloadableImages(s.history.present, s.selection).length > 0);
  const effective = selection.length ? scopeKind : "board";

  const run = async (close, task) => {
    close({ restoreFocus: false });
    const { history, boardName } = useCanvasStore.getState();
    const state = history.present;
    const scope = exportScope(state, useCanvasStore.getState().selection, effective);
    setStatus("");
    try {
      await task(state, scope, boardName);
    } catch {
      setStatus("Export failed");
    }
  };

  const empty = () => setStatus("Nothing to export");

  const saveImage = (close, size) => run(close, async (state, scope, name) => {
    const svg = await buildSvg(state, scope, { background: "#ffffff" });
    if (!svg) return empty();
    downloadBlob(await svgToJpeg(svg, size.scale), exportFileName(name, "jpg"));
  });

  return (
    <>
    {status && (
      <div role="status" className="absolute bottom-12 right-0 whitespace-nowrap rounded-md border border-line bg-ink-800 px-3 py-1.5 text-xs text-white/80 shadow-pop">
        {status}
      </div>
    )}
    <Dropdown
      label="Export"
      side="top"
      align="right"
      panelClassName="w-56"
      trigger={(open) => (
        <span
          title="Export"
          className={cn(
            "grid h-7 w-7 place-items-center rounded-md text-white/55 transition hover:bg-white/[0.07] hover:text-white",
            open && "bg-white/[0.07] text-white"
          )}
        >
          <Download className="h-3.5 w-3.5" />
        </span>
      )}
    >
      {(close) => (
        <>
          <div className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-white/40">Export</div>
          {[["board", "Whole board"], ["selection", "Selection"]].map(([value, label]) => (
            <MenuItem
              key={value}
              role="menuitemradio"
              checked={effective === value}
              disabled={value === "selection" && !selection.length}
              onClick={() => setScopeKind(value)}
            >
              <span className="flex-1">{label}</span>
              {effective === value && <span className="text-xs text-brand">On</span>}
            </MenuItem>
          ))}
          <div className="my-1 h-px bg-line" />
          {IMAGE_SIZES.map((size) => (
            <MenuItem key={size.value} onClick={() => saveImage(close, size)}>
              <span className="flex-1">Save as JPG ({size.label})</span>
            </MenuItem>
          ))}
          <MenuItem onClick={() => run(close, async (state, scope, name) => {
            const svg = await buildSvg(state, scope);
            if (!svg) return empty();
            downloadBlob(new Blob([svg], { type: "image/svg+xml" }), exportFileName(name, "svg"));
          })}>
            <span className="flex-1">Save as SVG</span>
          </MenuItem>
          <MenuItem onClick={() => run(close, async (state, scope, name) => {
            const pdf = buildPdf(state, scope);
            if (!pdf) return empty();
            downloadBlob(pdf, exportFileName(name, "pdf"));
          })}>
            <span className="flex-1">Save as PDF</span>
          </MenuItem>
          <MenuItem onClick={() => run(close, async (state, scope, name) => {
            const csv = buildCsv(state, scope);
            if (!csv) return empty();
            downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), exportFileName(name, "csv"));
          })}>
            <span className="flex-1">Export text as CSV</span>
          </MenuItem>
          <MenuItem
            disabled={!hasOriginals}
            onClick={() => run(close, async (state) => {
              if (!await downloadOriginals(state, useCanvasStore.getState().selection)) setStatus("Original not available");
            })}
          >
            <span className="flex-1">Download original file</span>
          </MenuItem>
          <MenuItem onClick={() => run(close, async (state, scope) => {
            const svg = await buildSvg(state, scope, { background: "#ffffff" });
            if (!svg) return empty();
            printSvg(svg);
          })}>
            <span className="flex-1">Print</span>
          </MenuItem>
        </>
      )}
    </Dropdown>
    </>
  );
}
