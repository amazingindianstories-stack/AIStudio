"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, Download, MonitorUp, MoreHorizontal, Pause, Pencil, Play, Square, Trash2, Video, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCanvasStore } from "@/lib/canvas-store";
import { canEditRole, canShareRole } from "@/lib/board-access";
import { currentUserId } from "@/lib/canvas/sticky-actions";
import { formatTime } from "@/lib/canvas/talktrack";
import { useTalktrackStore } from "@/lib/canvas/talktrack-store";
import { useTalktrackRecording } from "@/lib/canvas/talktrack-recording";

const ICON_BUTTON = "grid h-7 w-7 place-items-center rounded-full text-white/70 outline-none transition hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-brand";
const STATUS_TEXT = { processing: "Getting ready", cutting: "Cutting", failed: "Processing failed, still playable" };

function when(ms) {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** One recording in a list: play, and for its recorder or a board manager rename, download and delete. */
function Row({ track, canManage, onOpen, onRemoved }) {
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(track.title);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const store = useTalktrackStore.getState();
  const finishRename = async () => {
    setRenaming(false);
    const next = title.trim();
    if (!next || next === track.title) { setTitle(track.title); return; }
    try { await store.rename(track.id, next); } catch { setTitle(track.title); }
  };
  const remove = async () => {
    setBusy(true);
    try { await store.remove(track.id, track.boardId); onRemoved?.(); } catch { setBusy(false); setConfirmDelete(false); }
  };
  return (
    <li data-talktrack-row={track.id} className="group flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-white/5">
      <button
        type="button"
        aria-label={`Play ${track.title}`}
        onClick={() => onOpen(track)}
        className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand/90 text-white outline-none transition hover:bg-brand focus-visible:ring-2 focus-visible:ring-brand"
      >
        <Play className="h-3.5 w-3.5 translate-x-px" />
      </button>
      <div className="min-w-0 flex-1">
        {renaming ? (
          <input
            autoFocus
            aria-label="Recording name"
            value={title}
            maxLength={120}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={finishRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") { setTitle(track.title); setRenaming(false); }
            }}
            className="w-full rounded border border-line bg-ink-800 px-1.5 py-0.5 text-sm text-white outline-none focus:border-brand"
          />
        ) : (
          <button type="button" onClick={() => onOpen(track)} className="block w-full truncate text-left text-sm text-white outline-none focus-visible:underline">
            {track.title}
          </button>
        )}
        <p className="truncate text-[11px] text-white/50">
          {formatTime(track.trimEndMs - track.trimStartMs)} · {when(track.createdAt)}
          {track.viewerCount ? ` · ${track.viewerCount} ${track.viewerCount === 1 ? "view" : "views"}` : ""}
          {track.boardName ? ` · ${track.boardName}` : ""}
          {STATUS_TEXT[track.status] ? ` · ${STATUS_TEXT[track.status]}` : ""}
        </p>
      </div>
      <div className="relative">
        <button type="button" aria-label={`More for ${track.title}`} aria-expanded={menu} onClick={() => setMenu((value) => !value)} className={ICON_BUTTON}>
          <MoreHorizontal className="h-4 w-4" />
        </button>
        {menu && (
          <div role="menu" className="absolute right-0 top-full z-10 mt-1 w-40 rounded-xl border border-line bg-ink-750 p-1 shadow-pop">
            <a role="menuitem" href={track.url} download={`${track.title}.${track.mime.includes("mp4") ? "mp4" : "webm"}`} onClick={() => setMenu(false)} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-white/85 hover:bg-white/10">
              <Download className="h-3.5 w-3.5" />Download
            </a>
            {canManage && (
              <>
                <button type="button" role="menuitem" onClick={() => { setMenu(false); setRenaming(true); }} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-white/85 hover:bg-white/10">
                  <Pencil className="h-3.5 w-3.5" />Rename
                </button>
                <button type="button" role="menuitem" onClick={() => { setMenu(false); setConfirmDelete(true); }} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-red-300 hover:bg-white/10">
                  <Trash2 className="h-3.5 w-3.5" />Delete
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {confirmDelete && (
        <div role="alertdialog" aria-label={`Delete ${track.title}`} className="absolute inset-x-2 z-20 rounded-xl border border-line bg-ink-750 p-3 shadow-pop">
          <p className="text-sm text-white">Delete this recording?</p>
          <p className="mt-0.5 text-xs text-white/55">Its reactions and view history go with it.</p>
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" onClick={() => setConfirmDelete(false)} className="rounded-full px-3 py-1 text-xs text-white/80 hover:bg-white/10">Cancel</button>
            <button type="button" disabled={busy} onClick={remove} className="rounded-full bg-red-500/90 px-3 py-1 text-xs font-semibold text-white hover:bg-red-500 disabled:opacity-50">Delete</button>
          </div>
        </div>
      )}
    </li>
  );
}

/** Recording controls shown while a Talktrack is being made, at the top of the board next to the timer. */
export function RecorderBar() {
  const state = useTalktrackRecording((s) => s.state);
  const countdown = useTalktrackRecording((s) => s.countdown);
  const elapsedMs = useTalktrackRecording((s) => s.elapsedMs);
  const saving = useTalktrackStore((s) => s.saving);
  const error = useTalktrackRecording((s) => s.error);
  const recording = useTalktrackRecording.getState();
  if (state === "idle" && !error) return null;
  return (
    <div data-talktrack-recorder={state} role="status" className="flex items-center gap-2 rounded-full border border-line bg-ink-750/95 py-1 pl-3 pr-1.5 shadow-pop backdrop-blur-xl">
      {state === "countdown" && (
        <>
          <span className="text-sm text-white">Recording starts in <strong data-talktrack-countdown>{countdown}</strong></span>
          <button type="button" aria-label="Cancel recording" onClick={recording.cancelCountdown} className={ICON_BUTTON}><X className="h-4 w-4" /></button>
        </>
      )}
      {(state === "recording" || state === "paused") && (
        <>
          <span aria-hidden className={cn("h-2.5 w-2.5 rounded-full bg-red-500", state === "recording" && "animate-pulse")} />
          <span className="font-mono text-sm tabular-nums text-white" data-talktrack-elapsed>{formatTime(elapsedMs)}</span>
          {state === "paused" && <span className="text-[11px] uppercase tracking-wide text-white/50">Paused</span>}
          {state === "recording"
            ? <button type="button" aria-label="Pause recording" onClick={recording.pause} className={ICON_BUTTON}><Pause className="h-4 w-4" /></button>
            : <button type="button" aria-label="Resume recording" onClick={recording.resume} className={ICON_BUTTON}><Play className="h-4 w-4" /></button>}
          <button type="button" aria-label="Stop and save recording" onClick={() => void recording.stop()} className="flex items-center gap-1.5 rounded-full bg-red-500/90 px-3 py-1 text-xs font-semibold text-white hover:bg-red-500">
            <Square className="h-3 w-3" />Stop
          </button>
        </>
      )}
      {state === "saving" && <span className="pr-2 text-sm text-white/80">{saving === "uploading" ? "Saving your recording..." : "Finishing..."}</span>}
      {state === "idle" && error && (
        <>
          <span className="max-w-[26rem] text-sm text-white/85">{error}</span>
          <button type="button" aria-label="Dismiss" onClick={recording.clearError} className={ICON_BUTTON}><X className="h-4 w-4" /></button>
        </>
      )}
    </div>
  );
}

/**
 * The header's Talktrack button: record the screen or camera, and the board's library of recordings, with
 * "Your recordings" (everything the person recorded) beside it.
 */
export function TalktrackButton({ boardId, activeProjectId, onOpenBoard }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("board");
  const rootRef = useRef(null);
  const role = useCanvasStore((s) => s.boardRole);
  const tracks = useTalktrackStore((s) => s.tracks);
  const loaded = useTalktrackStore((s) => s.loaded);
  const mine = useTalktrackStore((s) => s.mine);
  const mineLoaded = useTalktrackStore((s) => s.mineLoaded);
  const error = useTalktrackStore((s) => s.error);
  const state = useTalktrackRecording((s) => s.state);
  const source = useTalktrackRecording((s) => s.source);
  const supported = useTalktrackRecording((s) => s.supported);
  const editable = canEditRole(role);
  const me = currentUserId();

  useEffect(() => {
    const store = useTalktrackStore.getState();
    store.open(boardId);
    void store.load();
    useTalktrackRecording.getState().checkSupport();
    return () => {
      useTalktrackRecording.getState().discard();
      useTalktrackStore.getState().close();
    };
  }, [boardId]);
  useEffect(() => {
    if (open && tab === "mine") void useTalktrackStore.getState().loadMine();
    if (open && tab === "board") void useTalktrackStore.getState().load();
  }, [open, tab]);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => { if (!rootRef.current?.contains(event.target)) setOpen(false); };
    const onKey = (event) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onDown); window.removeEventListener("keydown", onKey); };
  }, [open]);

  const recording = state !== "idle";
  const start = () => { setOpen(false); useTalktrackRecording.getState().start(); };
  const openTrack = (track) => {
    setOpen(false);
    if (track.boardId === boardId) useTalktrackStore.getState().play(track.id);
    else onOpenBoard?.(track.boardId);
  };
  const list = tab === "board" ? tracks : mine;
  const ready = tab === "board" ? loaded : mineLoaded;
  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-talktrack-button=""
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex items-center gap-1.5 rounded-full border border-line bg-ink-700 px-3 py-1.5 text-sm text-white/85 outline-none transition hover:text-white focus-visible:ring-2 focus-visible:ring-brand",
          (open || recording) && "bg-ink-600 text-white"
        )}
      >
        <Video className="h-3.5 w-3.5" />
        Talktrack
        {recording && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-red-500" />}
      </button>
      {open && (
        <div role="menu" data-talktrack-panel="" className="absolute left-0 top-full z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-2xl border border-line bg-ink-750/95 shadow-pop backdrop-blur-xl">
          {editable && (
            <div className="border-b border-line p-3">
              <div className="mb-2 flex gap-1" role="radiogroup" aria-label="What to record">
                {[["screen", "Screen", MonitorUp], ["camera", "Camera", Camera]].map(([value, label, Icon]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={source === value}
                    onClick={() => useTalktrackRecording.getState().setSource(value)}
                    className={cn("flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-brand",
                      source === value ? "border-brand bg-brand/15 text-white" : "border-line text-white/70 hover:text-white")}
                  >
                    <Icon className="h-3.5 w-3.5" />{label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                data-talktrack-record=""
                disabled={recording || !supported}
                onClick={start}
                className="flex w-full items-center justify-center gap-2 rounded-full bg-red-500/90 px-3 py-1.5 text-sm font-semibold text-white outline-none transition hover:bg-red-500 focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-40"
              >
                <span aria-hidden className="h-2 w-2 rounded-full bg-white" />Record a Talktrack
              </button>
              {!supported && <p className="mt-1.5 text-xs text-white/55">This browser cannot record.</p>}
            </div>
          )}
          <div className="flex gap-1 px-3 pt-2" role="tablist">
            {[["board", "This board"], ["mine", "Your recordings"]].map(([value, label]) => (
              <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}
                className={cn("rounded-full px-2.5 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-brand", tab === value ? "bg-white/10 text-white" : "text-white/55 hover:text-white")}>
                {label}
              </button>
            ))}
          </div>
          <ul className="max-h-72 overflow-y-auto p-1.5">
            {!ready && <li className="px-2 py-3 text-sm text-white/55">Loading...</li>}
            {ready && error && tab === "board" && <li className="px-2 py-3 text-sm text-white/70">{error}</li>}
            {ready && !list.length && !(error && tab === "board") && (
              <li className="px-2 py-3 text-sm text-white/55">
                {tab === "board" ? (editable ? "No recordings yet. Record a walk-through of this board." : "No recordings on this board yet.") : "You have not recorded anything yet."}
              </li>
            )}
            {list.map((track) => {
              const here = track.boardId === boardId;
              const sameProject = !track.projectId || track.projectId === activeProjectId;
              return (
                <Row
                  key={track.id}
                  track={track}
                  canManage={here && (track.ownerId === me || canShareRole(role)) || (!here && track.ownerId === me && sameProject)}
                  onOpen={here || sameProject ? openTrack : () => {}}
                />
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
