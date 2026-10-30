"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { LayoutGrid, Link2, List, Play, Rows3 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStore } from "@/lib/store";
import { useCanvasStore } from "@/lib/canvas-store";
import { useBoardUi } from "@/lib/canvas/board-ui";
import { frameOrderEdits, frameTitle, moveInOrder, orderedFrames, organizeFrameEdits } from "@/lib/canvas/frames";
import { objectLink } from "@/lib/canvas/object-link";
import { writeClipboardText } from "@/lib/canvas/clipboard-export";
import { BoardPanel, FrameThumbnail } from "./BoardPanel";
import { startPresentation } from "./useBoardShortcuts";

export const NOTES_MAX_LENGTH = 4000;

const FOOTER_BUTTON =
  "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-brand disabled:pointer-events-none disabled:opacity-40";

/** Copies a link that opens this board at `objectId`. */
export async function copyObjectLink(objectId) {
  const { activeProjectId } = useStore.getState();
  const { boardId } = useCanvasStore.getState();
  if (!boardId) return;
  const url = objectLink(window.location.origin, { project: activeProjectId, board: boardId, object: objectId });
  const ok = await writeClipboardText(url);
  useBoardUi.getState().notify(ok ? "Link copied" : "Could not copy the link");
}

/**
 * The board's frames in presentation order: jump to one, pick several,
 * drag (or Alt+arrow) to reorder, lay them out with "Organize frames", and
 * write presenter notes. The order and notes are board data, so only
 * editors change them.
 */
export function FramesPanel({ canEdit, onClose }) {
  const present = useCanvasStore((s) => s.history.present);
  const frames = useMemo(() => orderedFrames(present), [present]);
  const ids = useMemo(() => frames.map((f) => f.id), [frames]);
  const [layout, setLayout] = useState("thumbnails");
  const [picked, setPicked] = useState([]);
  const [anchor, setAnchor] = useState(null);
  const [dragging, setDragging] = useState(null);
  const [dropBefore, setDropBefore] = useState(undefined);
  const rowRefs = useRef(new Map());

  // Frames removed from the board drop out of the selection.
  const pickedIds = picked.filter((id) => ids.includes(id));
  const notesFrame = pickedIds.length === 1 ? frames.find((f) => f.id === pickedIds[0]) : null;

  const pick = (id, e) => {
    let next;
    if (e?.shiftKey && anchor && ids.includes(anchor)) {
      const [a, b] = [ids.indexOf(anchor), ids.indexOf(id)].sort((x, y) => x - y);
      next = ids.slice(a, b + 1);
    } else if (e?.metaKey || e?.ctrlKey) {
      next = pickedIds.includes(id) ? pickedIds.filter((x) => x !== id) : [...pickedIds, id];
      setAnchor(id);
    } else {
      next = [id];
      setAnchor(id);
    }
    setPicked(next);
    const store = useCanvasStore.getState();
    if (next.length === 1 && next[0] === id) store.focusObject(id);
    else store.setSelection(next);
  };

  const reorder = (moving, beforeId) => {
    const nextIds = moveInOrder(ids, moving, beforeId);
    const store = useCanvasStore.getState();
    store.replaceNodes(frameOrderEdits(store.history.present, nextIds));
  };

  const moveBy = (id, step) => {
    const moving = pickedIds.includes(id) ? pickedIds : [id];
    const movingSet = new Set(moving);
    const kept = ids.filter((x) => !movingSet.has(x));
    const at = ids.slice(0, ids.findIndex((x) => movingSet.has(x))).filter((x) => !movingSet.has(x)).length;
    const target = Math.max(0, Math.min(kept.length, at + step));
    if (target === at) return;
    reorder(moving, kept[target] ?? null);
    const frame = frames.find((f) => f.id === id);
    useBoardUi.getState().announce(`${frameTitle(frame)} moved ${step < 0 ? "up" : "down"}`);
    // The row keeps focus after the list re-renders in its new order.
    requestAnimationFrame(() => rowRefs.current.get(id)?.focus());
  };

  const onRowKeyDown = (e, id) => {
    const at = ids.indexOf(id);
    if (canEdit && e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      moveBy(id, e.key === "ArrowUp" ? -1 : 1);
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      rowRefs.current.get(ids[at + (e.key === "ArrowUp" ? -1 : 1)])?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      rowRefs.current.get(ids[e.key === "Home" ? 0 : ids.length - 1])?.focus();
    }
  };

  const organize = () => {
    const store = useCanvasStore.getState();
    store.replaceNodes(organizeFrameEdits(store.history.present));
    store.zoomToFit();
    useBoardUi.getState().notify("Frames organized");
  };

  const dropProps = (beforeId) => ({
    onDragOver: (e) => {
      if (!dragging) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDropBefore(beforeId);
    },
    onDrop: (e) => {
      if (!dragging) return;
      e.preventDefault();
      e.stopPropagation();
      reorder(dragging, beforeId);
      setDragging(null);
      setDropBefore(undefined);
    },
  });

  return (
    <BoardPanel
      label="Frames"
      title="Frames"
      subtitle={frames.length ? `${frames.length} ${frames.length === 1 ? "frame" : "frames"} in presentation order` : undefined}
      onClose={onClose}
      footer={
        <div className="flex flex-col gap-2">
          {notesFrame && <FrameNotes key={notesFrame.id} frame={notesFrame} canEdit={canEdit} />}
          <div className="flex items-center gap-1">
            <button type="button" disabled={!frames.length} onClick={startPresentation} className={cn(FOOTER_BUTTON, "bg-brand/20 text-brand hover:bg-brand/30")}>
              <Play className="h-3.5 w-3.5" />
              Present
            </button>
            {canEdit && (
              <button type="button" disabled={frames.length < 2} onClick={organize} className={cn(FOOTER_BUTTON, "text-white/75 hover:bg-white/10 hover:text-white")}>
                <LayoutGrid className="h-3.5 w-3.5" />
                Organize frames
              </button>
            )}
            <div className="ml-auto flex items-center rounded-lg bg-ink-800 p-0.5" role="group" aria-label="Frame list layout">
              {[
                { id: "thumbnails", label: "Thumbnails", Icon: Rows3 },
                { id: "list", label: "List", Icon: List },
              ].map(({ id, label, Icon }) => (
                <button
                  key={id}
                  type="button"
                  aria-label={label}
                  aria-pressed={layout === id}
                  onClick={() => setLayout(id)}
                  className={cn(
                    "grid h-6 w-7 place-items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-brand",
                    layout === id ? "bg-ink-600 text-white" : "text-white/45 hover:text-white"
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              ))}
            </div>
          </div>
        </div>
      }
    >
      {!frames.length ? (
        <p className="px-3 py-6 text-center text-sm text-white/50">
          No frames yet. {canEdit ? "Add a frame (F) to group a slide's content." : ""}
        </p>
      ) : (
        <>
        {canEdit && <p id="frames-reorder-hint" className="sr-only">Hold Alt and press the up or down arrow to move the selected frames.</p>}
        <ol
          aria-label="Frames in presentation order"
          aria-describedby={canEdit ? "frames-reorder-hint" : undefined}
          className="flex flex-col gap-1"
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) setDropBefore(undefined);
          }}
          {...dropProps(null)}
        >
          {frames.map((frame, i) => {
            const selected = pickedIds.includes(frame.id);
            return (
              <li
                key={frame.id}
                className={cn("relative", dropBefore === frame.id && "before:absolute before:-top-[3px] before:inset-x-2 before:h-0.5 before:rounded before:bg-brand")}
                {...dropProps(frame.id)}
              >
                <div
                  className={cn(
                    "group flex items-center gap-2 rounded-xl px-2 py-1.5 transition",
                    selected ? "bg-white/[0.09]" : "hover:bg-white/[0.05]",
                    dragging?.includes(frame.id) && "opacity-40"
                  )}
                >
                  <button
                    ref={(el) => (el ? rowRefs.current.set(frame.id, el) : rowRefs.current.delete(frame.id))}
                    type="button"
                    draggable={canEdit}
                    aria-pressed={selected}
                    onClick={(e) => pick(frame.id, e)}
                    onKeyDown={(e) => onRowKeyDown(e, frame.id)}
                    onDragStart={(e) => {
                      const moving = selected ? pickedIds : [frame.id];
                      setDragging(moving);
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", moving.join(","));
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setDropBefore(undefined);
                    }}
                    data-testid="frame-row"
                    className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  >
                    <span className="w-5 shrink-0 text-right text-xs tabular-nums text-white/40">{i + 1}</span>
                    {layout === "thumbnails" && (
                      <span className="grid h-12 w-20 shrink-0 place-items-center overflow-hidden rounded-md bg-ink-900 ring-1 ring-line">
                        <FrameThumbnail frame={frame} present={present} className="h-full w-full" />
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className={cn("block truncate text-sm", frame.name?.trim() ? "text-white/85" : "italic text-white/45")}>
                        {frameTitle(frame)}
                      </span>
                      {frame.notes && <span className="block truncate text-xs text-white/40">Has notes</span>}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Copy link to ${frameTitle(frame)}`}
                    onClick={() => void copyObjectLink(frame.id)}
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-white/40 opacity-0 outline-none hover:bg-white/10 hover:text-white focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-brand group-hover:opacity-100"
                  >
                    <Link2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
        </>
      )}
    </BoardPanel>
  );
}

/** Presenter notes for one frame. They are part of the board, so everyone who can open it can read them. */
function FrameNotes({ frame, canEdit }) {
  const [draft, setDraft] = useState(frame.notes ?? "");
  const saved = useRef(frame.notes ?? "");

  // Someone else's saved notes replace the draft unless this person is mid-edit.
  useEffect(() => {
    if ((frame.notes ?? "") !== saved.current) {
      if (draft === saved.current) setDraft(frame.notes ?? "");
      saved.current = frame.notes ?? "";
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame.notes]);

  const commit = () => {
    const store = useCanvasStore.getState();
    const node = store.history.present.nodes.find((n) => n.id === frame.id);
    const value = draft.trim() ? draft : "";
    if (!node || (node.notes ?? "") === value) return;
    const next = { ...node, notes: value };
    if (!value) delete next.notes;
    saved.current = value;
    store.replaceNodes(new Map([[node.id, next]]));
  };
  // Closing the panel or picking another frame keeps what was typed.
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => () => commitRef.current(), []);

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor="frame-notes" className="text-xs font-semibold text-white/70">
        Presenter notes for {frameTitle(frame)}
      </label>
      {canEdit ? (
        <textarea
          id="frame-notes"
          value={draft}
          maxLength={NOTES_MAX_LENGTH}
          rows={3}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          placeholder="What to say on this slide"
          className="resize-none rounded-lg bg-ink-800 px-2.5 py-2 text-sm text-white placeholder:text-white/35 outline-none ring-1 ring-line focus:ring-brand/70"
        />
      ) : (
        <p id="frame-notes" className="max-h-24 overflow-y-auto whitespace-pre-wrap rounded-lg bg-ink-800 px-2.5 py-2 text-sm text-white/75">
          {frame.notes || "No notes"}
        </p>
      )}
      <p className="text-[11px] leading-snug text-white/45">Not private: anyone who can open this board can read these notes.</p>
    </div>
  );
}
