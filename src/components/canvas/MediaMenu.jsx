"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Code2, FolderOpen, Link2, Paperclip, Shapes, Smile, Upload, X } from "lucide-react";
import { Dropdown, MenuItem } from "@/components/Dropdown";
import { apiFetch } from "@/lib/api";
import { cn } from "@/lib/utils";
import { CODE_LANGUAGES } from "@/lib/canvas/media-nodes";
import { LANGUAGE_LABELS } from "@/lib/canvas/code-highlight";
import { EMOJI, SKIN_TONES, readRecents, readTone, rememberRecent, saveTone, searchEmoji } from "@/lib/canvas/emoji-set";
import { ICON_COLORS, ICONS, searchIcons } from "@/lib/canvas/icon-set";
import { addCodeBlock, addEmoji, addIcon, addMedia, updateCodeBlock } from "@/lib/canvas/media-actions";
import { mediaNodeFields } from "@/lib/canvas/media-upload";
import { useCanvasStore } from "@/lib/canvas-store";

const FIELD = "w-full rounded-lg border border-line bg-ink-800 px-3 py-2 text-sm text-white outline-none placeholder:text-white/25 focus:border-brand/40";
const PRIMARY = "rounded-lg bg-brand/90 px-3 py-1.5 text-sm font-semibold text-ink-900 outline-none hover:bg-brand focus-visible:ring-2 focus-visible:ring-white/60 disabled:cursor-not-allowed disabled:opacity-45";
const GHOST = "rounded-lg px-3 py-1.5 text-sm font-medium text-white/70 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-brand";

/** The toolbar's media menu: upload, link or embed, emoji, icons, code block and saved files. */
export function MediaMenu({ onUploadClick, onUrl, viewCenter }) {
  const [dialog, setDialog] = useState(null);
  return (
    <>
      <Dropdown
        side="top"
        label="Add media"
        trigger={(open) => (
          <span
            title="Add media"
            className={cn("grid h-9 w-9 place-items-center rounded-lg text-white/55 transition-colors hover:bg-white/[0.07] hover:text-white max-sm:h-8 max-sm:w-8", open && "bg-white/[0.07] text-white")}
          >
            <Paperclip className="h-4 w-4" />
          </span>
        )}
      >
        {(close) => (
          <>
            <MenuItem onClick={() => { onUploadClick(); close(); }}><Upload className="h-4 w-4 text-white/45" /> Upload file</MenuItem>
            <MenuItem onClick={() => { setDialog("link"); close(); }}><Link2 className="h-4 w-4 text-white/45" /> Link or embed</MenuItem>
            <MenuItem onClick={() => { setDialog("emoji"); close(); }}><Smile className="h-4 w-4 text-white/45" /> Emoji and stickers</MenuItem>
            <MenuItem onClick={() => { setDialog("icons"); close(); }}><Shapes className="h-4 w-4 text-white/45" /> Icons</MenuItem>
            <MenuItem onClick={() => { setDialog("code"); close(); }}><Code2 className="h-4 w-4 text-white/45" /> Code block</MenuItem>
            <MenuItem onClick={() => { setDialog("files"); close(); }}><FolderOpen className="h-4 w-4 text-white/45" /> Saved files</MenuItem>
          </>
        )}
      </Dropdown>
      {dialog === "link" && <LinkDialog onClose={() => setDialog(null)} onUrl={onUrl} />}
      {dialog === "emoji" && <EmojiDialog onClose={() => setDialog(null)} viewCenter={viewCenter} />}
      {dialog === "icons" && <IconDialog onClose={() => setDialog(null)} viewCenter={viewCenter} />}
      {dialog === "code" && <CodeDialog onClose={() => setDialog(null)} viewCenter={viewCenter} />}
      {dialog === "files" && <FilesDialog onClose={() => setDialog(null)} viewCenter={viewCenter} />}
    </>
  );
}

/** Shared modal: focus moves in on open, Escape closes, Tab stays inside. */
export function MediaDialog({ title, label, onClose, children, wide = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => ref.current?.querySelector("[data-autofocus], input, textarea, button")?.focus());
    return () => {
      cancelAnimationFrame(frame);
      document.querySelector('[aria-label="Add media"][aria-haspopup]')?.focus?.();
    };
  }, []);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[200] grid place-items-center bg-black/55 p-4" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label || title}
        className={cn("flex max-h-[85vh] w-full flex-col rounded-2xl border border-line bg-ink-750 p-5 shadow-pop", wide ? "max-w-2xl" : "max-w-md")}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "Tab") {
            const focusable = [...e.currentTarget.querySelectorAll("input, textarea, select, button:not(:disabled), a[href]")];
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <div className="mb-3 flex items-center">
          <h2 className="text-sm font-semibold text-white">{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="ml-auto grid h-7 w-7 place-items-center rounded-lg text-white/50 hover:bg-white/10 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  );
}

function LinkDialog({ onClose, onUrl }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await onUrl(text);
      onClose();
    } catch (e) {
      setError(e.message || "Could not add this link.");
      setBusy(false);
    }
  };
  return (
    <MediaDialog title="Add a link or embed" label="Link or embed" onClose={onClose}>
      <p className="mb-2 text-xs text-white/50">Paste a link to a file, a web page (shown as a preview card), a YouTube, Vimeo, Loom, Spotify, SoundCloud, Figma or Drive page, or its iframe code.</p>
      <textarea
        data-autofocus=""
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        aria-label="Link or iframe code"
        placeholder="https://..."
        className={cn(FIELD, "resize-y font-mono text-xs")}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
        }}
      />
      {error && <p role="alert" className="mt-2 text-xs text-red-300">{error}</p>}
      <div className="mt-3 flex items-center gap-2">
        <span className="text-xs text-white/40">⌘ Enter to add</span>
        <button type="button" onClick={onClose} className={cn(GHOST, "ml-auto")}>Cancel</button>
        <button type="button" onClick={submit} disabled={!text.trim() || busy} className={PRIMARY}>{busy ? "Adding…" : "Add to board"}</button>
      </div>
    </MediaDialog>
  );
}

function EmojiDialog({ onClose, viewCenter }) {
  const [query, setQuery] = useState("");
  const [tone, setTone] = useState(() => readTone());
  const [recents, setRecents] = useState(() => readRecents());
  const [sticker, setSticker] = useState(false);
  const [interactive, setInteractive] = useState(false);
  const results = searchEmoji(query, tone);
  const place = (emoji) => {
    setRecents(rememberRecent(emoji));
    addEmoji(emoji, { sticker, interactive }, viewCenter());
  };
  return (
    <MediaDialog title="Emoji and stickers" onClose={onClose} wide>
      <input data-autofocus="" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search emoji" placeholder="Search emoji" className={FIELD} />
      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-white/60">
        <label className="flex items-center gap-1.5">
          Skin tone
          <select aria-label="Skin tone" value={tone} onChange={(e) => { setTone(e.target.value); saveTone(e.target.value); }} className="rounded-md border border-line bg-ink-800 px-1.5 py-1 text-white">
            {SKIN_TONES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={sticker} onChange={(e) => setSticker(e.target.checked)} /> Sticker style</label>
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={interactive} onChange={(e) => setInteractive(e.target.checked)} /> Click to agree</label>
      </div>
      {recents.length > 0 && !query && (
        <div className="mt-3">
          <p className="mb-1 text-[11px] uppercase tracking-wide text-white/35">Recent</p>
          <div className="flex flex-wrap gap-1" aria-label="Recent emoji">
            {recents.map((emoji) => <EmojiButton key={emoji} emoji={emoji} onPick={place} />)}
          </div>
        </div>
      )}
      <div className="mt-3 grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(2.5rem,1fr))] gap-1 overflow-y-auto" aria-label="Emoji">
        {results.map((entry) => <EmojiButton key={entry.base} emoji={entry.emoji} name={entry.name} onPick={place} />)}
        {!results.length && <p className="col-span-full py-6 text-center text-sm text-white/45">No emoji match {`"${query}"`}.</p>}
      </div>
      <p className="mt-2 text-xs text-white/35">{EMOJI.length} emoji. Click one to place it in the middle of the view.</p>
    </MediaDialog>
  );
}

function EmojiButton({ emoji, name, onPick }) {
  return (
    <button type="button" aria-label={name ? name.split(" ").slice(0, 2).join(" ") + " " + emoji : emoji} title={name} onClick={() => onPick(emoji)} className="grid h-10 w-10 place-items-center rounded-lg text-2xl hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-brand">
      {emoji}
    </button>
  );
}

function IconDialog({ onClose, viewCenter }) {
  const [query, setQuery] = useState("");
  const [color, setColor] = useState(ICON_COLORS[0]);
  const names = searchIcons(query);
  return (
    <MediaDialog title="Icons" onClose={onClose} wide>
      <input data-autofocus="" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search icons" placeholder="Search icons" className={FIELD} />
      <div className="mt-3 flex items-center gap-1.5" role="radiogroup" aria-label="Icon color">
        {ICON_COLORS.map((c) => (
          <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={`Color ${c}`} onClick={() => setColor(c)}
            className={cn("h-6 w-6 rounded-full border-2", color === c ? "border-white" : "border-transparent")} style={{ background: c }} />
        ))}
      </div>
      <div className="mt-3 grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(3rem,1fr))] gap-1 overflow-y-auto" aria-label="Icons">
        {names.map((name) => {
          const Icon = ICONS[name];
          return (
            <button key={name} type="button" aria-label={name.replace(/-/g, " ")} title={name.replace(/-/g, " ")} onClick={() => addIcon(name, color, viewCenter())}
              className="grid h-12 w-12 place-items-center rounded-lg hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-brand">
              <Icon className="h-6 w-6" style={{ color }} />
            </button>
          );
        })}
        {!names.length && <p className="col-span-full py-6 text-center text-sm text-white/45">No icons match {`"${query}"`}.</p>}
      </div>
    </MediaDialog>
  );
}

/** Add a code block, or edit the code of one already on the board (`node`). */
export function CodeDialog({ onClose, viewCenter, node }) {
  const [code, setCode] = useState(node?.code ?? "");
  const [language, setLanguage] = useState(node?.language ?? "javascript");
  const submit = () => {
    if (node) updateCodeBlock(node.id, { code, language });
    else addCodeBlock({ code, language }, viewCenter());
    onClose();
  };
  return (
    <MediaDialog title={node ? "Edit code block" : "Add a code block"} label="Code block" onClose={onClose} wide>
      <label className="mb-2 flex items-center gap-2 text-xs text-white/60">
        Language
        <select aria-label="Language" value={language} onChange={(e) => setLanguage(e.target.value)} className="rounded-md border border-line bg-ink-800 px-1.5 py-1 text-white">
          {CODE_LANGUAGES.map((l) => <option key={l} value={l}>{LANGUAGE_LABELS[l]}</option>)}
        </select>
      </label>
      <textarea data-autofocus="" value={code} onChange={(e) => setCode(e.target.value)} rows={12} spellCheck={false} aria-label="Code" placeholder="Paste or type code" className={cn(FIELD, "resize-y font-mono text-xs")} />
      <div className="mt-3 flex items-center gap-2">
        <button type="button" onClick={onClose} className={cn(GHOST, "ml-auto")}>Cancel</button>
        <button type="button" onClick={submit} disabled={!code.trim()} className={PRIMARY}>{node ? "Save code" : "Add code block"}</button>
      </div>
    </MediaDialog>
  );
}

/** Reusable board files from every board the person can read, newest first, in pages. */
function FilesDialog({ onClose, viewCenter }) {
  const boardId = useCanvasStore((s) => s.boardId);
  const [files, setFiles] = useState([]);
  const [next, setNext] = useState(null);
  const [state, setState] = useState("loading");
  const load = async (before) => {
    setState("loading");
    try {
      const response = await apiFetch(`/api/canvas-boards/${boardId}/media${before ? `?before=${before}` : ""}`, { cache: "no-store" });
      if (!response.ok) throw new Error();
      const page = await response.json();
      setFiles((current) => [...current, ...page.files]);
      setNext(page.next);
      setState("ready");
    } catch {
      setState("error");
    }
  };
  useEffect(() => {
    load(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId]);
  return (
    <MediaDialog title="Saved files" onClose={onClose} wide>
      <div className="grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2 overflow-y-auto" aria-label="Saved files">
        {files.map((file) => <SavedFile key={file.id} file={file} onPick={() => addMedia(mediaNodeFields(file), viewCenter())} />)}
      </div>
      {state === "ready" && !files.length && <p className="py-6 text-center text-sm text-white/45">Files you add to boards are saved here for reuse.</p>}
      {state === "error" && <p role="alert" className="py-3 text-sm text-red-300">Could not load saved files. <button type="button" className="underline" onClick={() => load(null)}>Try again</button></p>}
      {next && state !== "loading" && <button type="button" onClick={() => load(next)} className={cn(GHOST, "mt-2 self-start")}>Load more</button>}
      {state === "loading" && <p className="py-3 text-sm text-white/45">Loading…</p>}
    </MediaDialog>
  );
}

function SavedFile({ file, onPick }) {
  const image = file.contentType.startsWith("image/");
  return (
    <button type="button" onClick={onPick} aria-label={`Place ${file.name}`} title={file.name}
      className="flex flex-col overflow-hidden rounded-lg border border-line bg-ink-800 text-left hover:border-brand/40 focus-visible:ring-2 focus-visible:ring-brand">
      <span className="grid aspect-square w-full place-items-center overflow-hidden bg-ink-900 text-xs text-white/45">
        {image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={file.url} alt="" loading="lazy" draggable={false} className="h-full w-full object-cover" />
        ) : (
          file.contentType.split("/")[1]?.toUpperCase().slice(0, 6)
        )}
      </span>
      <span className="truncate px-2 py-1 text-[11px] text-white/70">{file.name}</span>
    </button>
  );
}
