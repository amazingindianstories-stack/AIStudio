"use client";

import { useRef, useState } from "react";
import { Code2, ImageUp, Layers, Link2, Pencil, RotateCw, Trash2 } from "lucide-react";
import { useCanvasStore, selectReadOnly } from "@/lib/canvas-store";
import { cn } from "@/lib/utils";
import { extractPdfPages, renameMedia, replaceImage, setObjectLink } from "@/lib/canvas/media-actions";
import { uploadBoardFile } from "@/lib/canvas/media-upload";
import { ICON_COLORS } from "@/lib/canvas/icon-set";
import { CodeDialog } from "./MediaMenu";

const BUTTON = "flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-white/75 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-brand";
const FIELD = "h-8 rounded-lg border border-line bg-ink-800 px-2 text-xs text-white outline-none placeholder:text-white/25 focus:border-brand/40";

function selectedNode(state) {
  if (state.selection.length !== 1 || state.selectedConnectorIds.length) return null;
  return state.history.present.nodes.find((n) => n.id === state.selection[0]) ?? null;
}

/**
 * The actions for the one selected object that the style bar does not cover: rename a video, replace an
 * image, extract PDF pages, edit code, change an emoji or icon, and link the object to a website, board or
 * object. Reads the board from the store, so it works for objects scrolled out of view.
 */
export function MediaSelectionBar({ hidden, boardId, notify }) {
  const node = useCanvasStore(selectedNode);
  const readOnly = useCanvasStore(selectReadOnly);
  const fileRef = useRef(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [codeOpen, setCodeOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (hidden || readOnly || !node || node.type === "frame" || node.type === "stack") return null;
  const titled = ["video", "audio", "pdf", "embed"].includes(node.type);
  const updateFields = useCanvasStore.getState().updateNodeFields;

  const replace = async (file) => {
    if (!file || busy) return;
    setBusy(true);
    try {
      replaceImage(node.id, await uploadBoardFile(file, boardId));
    } catch (error) {
      notify?.(error.message || "Could not replace the image.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="toolbar"
      aria-label="Object actions"
      className="absolute bottom-[8.25rem] left-1/2 z-40 flex max-w-[calc(100%-1rem)] -translate-x-1/2 flex-wrap items-center gap-1 rounded-2xl border border-line bg-ink-750/95 p-1 shadow-pop backdrop-blur-xl max-lg:bottom-44"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {titled && (
        <label className="flex items-center gap-1 pl-1 text-xs text-white/50">
          <Pencil className="h-3 w-3" aria-hidden />
          <input
            key={node.id}
            aria-label={node.type === "pdf" ? "File name" : "Title"}
            defaultValue={node.type === "pdf" ? node.name : node.title}
            maxLength={200}
            onBlur={(e) => renameMedia(node.id, e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            className={cn(FIELD, "w-40")}
          />
        </label>
      )}
      {node.type === "image" && (
        <>
          <button type="button" className={BUTTON} disabled={busy} onClick={() => fileRef.current?.click()}>
            <ImageUp className="h-3.5 w-3.5" /> {busy ? "Replacing…" : "Replace image"}
          </button>
          <input ref={fileRef} type="file" accept="image/*,.psd" className="hidden" aria-label="Replacement image" tabIndex={-1}
            onChange={(e) => { replace(e.target.files?.[0]); e.target.value = ""; }} />
        </>
      )}
      {node.type === "pdf" && (
        <button type="button" className={BUTTON} onClick={() => notify?.(`Extracted ${extractPdfPages(node.id).length} pages.`)}>
          <Layers className="h-3.5 w-3.5" /> Extract pages
        </button>
      )}
      {node.type === "code" && (
        <>
          <button type="button" className={BUTTON} onClick={() => setCodeOpen(true)}><Code2 className="h-3.5 w-3.5" /> Edit code</button>
          <label className="flex items-center gap-1 text-xs text-white/50">
            Size
            <input type="number" aria-label="Font size" min={8} max={64} value={node.fontSize} onChange={(e) => updateFields(node.id, { fontSize: Math.min(64, Math.max(8, Number(e.target.value) || 14)) })} className={cn(FIELD, "w-14")} />
          </label>
          <label className="flex items-center gap-1 text-xs text-white/60">
            <input type="checkbox" checked={node.lineNumbers} onChange={(e) => updateFields(node.id, { lineNumbers: e.target.checked })} /> Line numbers
          </label>
        </>
      )}
      {node.type === "emoji" && (
        <>
          <label className="flex items-center gap-1 px-1 text-xs text-white/60"><input type="checkbox" checked={node.style === "sticker"} onChange={(e) => updateFields(node.id, { style: e.target.checked ? "sticker" : undefined })} /> Sticker</label>
          <label className="flex items-center gap-1 px-1 text-xs text-white/60"><input type="checkbox" checked={Boolean(node.interactive)} onChange={(e) => updateFields(node.id, { interactive: e.target.checked || undefined, agreedBy: e.target.checked ? node.agreedBy : undefined })} /> Click to agree</label>
          <button type="button" className={BUTTON} aria-label="Rotate 15 degrees" onClick={() => updateFields(node.id, { rotation: ((node.rotation ?? 0) + 15) % 360 })}><RotateCw className="h-3.5 w-3.5" /> Rotate</button>
        </>
      )}
      {node.type === "icon" && (
        <div className="flex items-center gap-1 px-1" role="radiogroup" aria-label="Icon color">
          {ICON_COLORS.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={node.color === c} aria-label={`Color ${c}`} onClick={() => updateFields(node.id, { color: c })}
              className={cn("h-5 w-5 rounded-full border-2", node.color === c ? "border-white" : "border-transparent")} style={{ background: c }} />
          ))}
        </div>
      )}
      <button type="button" className={cn(BUTTON, node.link && "text-brand")} aria-expanded={linkOpen} onClick={() => setLinkOpen((v) => !v)}>
        <Link2 className="h-3.5 w-3.5" /> {node.link ? "Edit link" : "Add link"}
      </button>
      {linkOpen && <LinkEditor key={node.id} node={node} onDone={() => setLinkOpen(false)} notify={notify} />}
      {codeOpen && <CodeDialog node={node} onClose={() => setCodeOpen(false)} />}
    </div>
  );
}

/** One link per object: a website, another board (its id) or an object on this board (its id). */
function LinkEditor({ node, onDone, notify }) {
  const current = node.link?.url ?? (node.link?.nodeId ? `object:${node.link.nodeId}` : node.link?.boardId ? `board:${node.link.boardId}` : "");
  const [value, setValue] = useState(current);
  const save = () => {
    const text = value.trim();
    let link = null;
    if (/^https?:\/\//i.test(text)) link = { url: text };
    else if (/^object:/.test(text)) link = { nodeId: text.slice(7) };
    else if (/^board:/.test(text)) link = { boardId: text.slice(6) };
    if (text && !setObjectLink(node.id, link)) return notify?.("Enter a web address starting with http:// or https://.");
    if (!text) setObjectLink(node.id, null);
    onDone();
  };
  return (
    <span className="flex items-center gap-1">
      <input autoFocus aria-label="Link address" value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://..." className={cn(FIELD, "w-56")}
        onKeyDown={(e) => { if (e.key === "Enter") save(); else if (e.key === "Escape") onDone(); }} />
      <button type="button" className={BUTTON} onClick={save}>Save link</button>
      {node.link && <button type="button" className={BUTTON} aria-label="Remove link" onClick={() => { setObjectLink(node.id, null); onDone(); }}><Trash2 className="h-3.5 w-3.5" /></button>}
    </span>
  );
}
