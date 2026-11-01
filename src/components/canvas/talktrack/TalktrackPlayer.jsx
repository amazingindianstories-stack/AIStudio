"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, RotateCcw, RotateCw, Send, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCanvasStore } from "@/lib/canvas-store";
import { canCommentRole, canEditRole, canShareRole } from "@/lib/board-access";
import { currentUserId } from "@/lib/canvas/sticky-actions";
import {
  REACTION_EMOJIS, SKIP_MS, SPEEDS, chapterAt, formatTime, playbackWindow, reactionBuckets, segmentIndexAt,
  skipTo, timeAtFraction, timelineFraction, viewersSummary,
} from "@/lib/canvas/talktrack";
import { useTalktrackStore } from "@/lib/canvas/talktrack-store";

const TAB = "rounded-full px-2.5 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-brand";
const ICON_BUTTON = "grid h-8 w-8 place-items-center rounded-full text-white/80 outline-none transition hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-40";
const SMALL = "rounded-full border border-line px-3 py-1 text-xs text-white/85 outline-none transition hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-40";

/** The Talktrack open on the board: video, timeline with reactions, and tabs for overview, transcript, comments, viewers and editing. */
export function TalktrackPlayer() {
  const id = useTalktrackStore((s) => s.playingId);
  const track = useTalktrackStore((s) => s.tracks.find((item) => item.id === s.playingId));
  if (!id || !track) return null;
  return <Player key={track.id} track={track} />;
}

function Player({ track }) {
  const store = useTalktrackStore.getState();
  const role = useCanvasStore((s) => s.boardRole);
  const transcriptionAvailable = useTalktrackStore((s) => s.transcriptionAvailable);
  const me = currentUserId();
  const canComment = canCommentRole(role);
  const canEdit = canEditRole(role) && (track.ownerId === me || canShareRole(role));
  const canSeeViewers = canEditRole(role);
  const video = useRef(null);
  const furthest = useRef(0);
  const window = useMemo(() => playbackWindow(track), [track]);
  const [playing, setPlaying] = useState(false);
  const [nowMs, setNowMs] = useState(window.start);
  const [speed, setSpeed] = useState(1);
  const [tab, setTab] = useState("overview");
  const [moments, setMoments] = useState([]);
  const [text, setText] = useState("");
  const [message, setMessage] = useState("");
  const [viewers, setViewers] = useState(null);
  const [busy, setBusy] = useState(false);
  const [mark, setMark] = useState({ start: null, end: null });
  const busyJob = track.status === "processing" || track.status === "cutting";

  const reportView = useCallback((completed) => {
    if (furthest.current > 0) void store.recordView(track.id, furthest.current, completed);
  }, [store, track.id]);
  useEffect(() => () => reportView(false), [reportView]);

  const seek = useCallback((ms) => {
    const el = video.current;
    if (!el) return;
    el.currentTime = Math.min(window.end, Math.max(window.start, ms)) / 1000;
    setNowMs(el.currentTime * 1000);
  }, [window]);
  const toggle = () => {
    const el = video.current;
    if (!el) return;
    if (el.paused) {
      if (el.currentTime * 1000 >= window.end - 50) seek(window.start);
      void el.play();
    } else el.pause();
  };
  const onTime = () => {
    const el = video.current;
    const ms = el.currentTime * 1000;
    if (ms >= window.end) {
      el.pause();
      el.currentTime = window.end / 1000;
      furthest.current = Math.max(furthest.current, window.end);
      setNowMs(window.end);
      reportView(true);
      return;
    }
    if (ms < window.start - 250) { seek(window.start); return; }
    furthest.current = Math.max(furthest.current, ms);
    setNowMs(ms);
  };

  useEffect(() => { if (video.current) video.current.playbackRate = speed; }, [speed]);
  useEffect(() => {
    let live = true;
    const load = () => store.moments(track.id).then((items) => live && setMoments(items)).catch(() => {});
    void load();
    const timer = setInterval(load, 8000);
    return () => { live = false; clearInterval(timer); };
  }, [store, track.id]);
  useEffect(() => {
    if (!busyJob) return undefined;
    const timer = setInterval(() => void store.refreshOne(track.id).catch(() => {}), 3000);
    return () => clearInterval(timer);
  }, [busyJob, store, track.id]);
  useEffect(() => {
    if (tab !== "viewers" || !canSeeViewers) return;
    void store.viewers(track.id).then(setViewers).catch(() => setViewers(null));
  }, [tab, canSeeViewers, store, track.id]);
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape" && !/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) store.play(null);
    };
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, [store]);

  const buckets = useMemo(() => reactionBuckets(moments, window), [moments, window]);
  const chapter = chapterAt(track.chapters, nowMs);
  const segments = track.transcript || [];
  const activeSegment = segmentIndexAt(segments, nowMs);
  const comments = moments.filter((item) => item.text);
  const run = async (work, failure) => {
    setBusy(true);
    setMessage("");
    try { await work(); } catch (error) { setMessage(error?.message || failure); }
    setBusy(false);
  };
  const react = (emoji) => run(async () => {
    const moment = await store.addMoment(track.id, { atMs: Math.round(nowMs), emoji });
    setMoments((items) => [...items, moment].sort((a, b) => a.atMs - b.atMs));
  }, "The reaction was not saved.");
  const comment = () => {
    const value = text.trim();
    if (!value) return;
    void run(async () => {
      const moment = await store.addMoment(track.id, { atMs: Math.round(nowMs), text: value });
      setMoments((items) => [...items, moment].sort((a, b) => a.atMs - b.atMs));
      setText("");
    }, "The comment was not saved.");
  };
  const dropMoment = (moment) => run(async () => {
    await store.removeMoment(track.id, moment.id);
    setMoments((items) => items.filter((item) => item.id !== moment.id));
  }, "That could not be removed.");
  const onTimeline = (event) => {
    const box = event.currentTarget.getBoundingClientRect();
    seek(timeAtFraction((event.clientX - box.left) / box.width, window));
  };
  const onTimelineKey = (event) => {
    if (event.key === "ArrowLeft") { event.preventDefault(); seek(skipTo(nowMs, -5000, window)); }
    if (event.key === "ArrowRight") { event.preventDefault(); seek(skipTo(nowMs, 5000, window)); }
  };
  const bounds = { min: Math.round(nowMs) };

  return (
    <aside
      data-talktrack-player={track.id}
      aria-label={`Talktrack ${track.title}`}
      className="absolute bottom-4 right-4 z-40 flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-line bg-ink-750/95 shadow-pop backdrop-blur-xl"
    >
      <header className="flex items-center gap-2 px-3 pt-2.5">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-white" title={track.title}>{track.title}</h2>
        <button type="button" aria-label="Close Talktrack" onClick={() => { reportView(false); store.play(null); }} className={ICON_BUTTON}><X className="h-4 w-4" /></button>
      </header>
      <div className="relative mx-3 mt-2 overflow-hidden rounded-xl bg-black">
        <video
          ref={video}
          src={track.url}
          playsInline
          preload="metadata"
          data-talktrack-video=""
          className="aspect-video w-full"
          onLoadedMetadata={() => { if (window.start > 0) seek(window.start); }}
          onTimeUpdate={onTime}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onClick={toggle}
        />
        {busyJob && (
          <p role="status" className="absolute inset-x-0 bottom-0 bg-black/70 px-3 py-1 text-center text-xs text-white/85">
            {track.status === "cutting" ? "Cutting the recording..." : "Getting your recording ready..."}
          </p>
        )}
      </div>
      <div className="px-3 pt-2">
        <div
          role="slider"
          tabIndex={0}
          aria-label="Timeline"
          aria-valuemin={0}
          aria-valuemax={Math.round(window.length / 1000)}
          aria-valuenow={Math.round((nowMs - window.start) / 1000)}
          aria-valuetext={`${formatTime(nowMs - window.start)} of ${formatTime(window.length)}`}
          data-talktrack-timeline=""
          onClick={onTimeline}
          onKeyDown={onTimelineKey}
          className="relative h-5 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          <div className="absolute inset-x-0 top-2 h-1 rounded-full bg-white/15">
            <div className="h-full rounded-full bg-brand" style={{ width: `${timelineFraction(nowMs, window) * 100}%` }} />
          </div>
          {(track.chapters || []).filter((item) => item.startMs > window.start && item.startMs < window.end).map((item) => (
            <span key={item.startMs} aria-hidden className="absolute top-1.5 h-2 w-px bg-white/60" style={{ left: `${timelineFraction(item.startMs, window) * 100}%` }} />
          ))}
          {buckets.map((bucket) => (
            <button
              key={bucket.index}
              type="button"
              data-talktrack-reaction=""
              aria-label={`${bucket.count} ${bucket.count === 1 ? "reaction" : "reactions"} at ${formatTime(bucket.atMs - window.start)}`}
              onClick={(event) => { event.stopPropagation(); seek(bucket.atMs); }}
              className="absolute -top-1 -translate-x-1/2 text-[11px] leading-none outline-none focus-visible:ring-2 focus-visible:ring-brand"
              style={{ left: `${bucket.fraction * 100}%` }}
            >
              {bucket.top}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <button type="button" aria-label={playing ? "Pause" : "Play"} onClick={toggle} disabled={busyJob && !video.current} className={ICON_BUTTON}>
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </button>
          <button type="button" aria-label="Back 10 seconds" onClick={() => seek(skipTo(nowMs, -SKIP_MS, window))} className={ICON_BUTTON}><RotateCcw className="h-4 w-4" /></button>
          <button type="button" aria-label="Forward 10 seconds" onClick={() => seek(skipTo(nowMs, SKIP_MS, window))} className={ICON_BUTTON}><RotateCw className="h-4 w-4" /></button>
          <span className="ml-1 font-mono text-xs tabular-nums text-white/70" data-talktrack-time="">
            {formatTime(nowMs - window.start)} / {formatTime(window.length)}
          </span>
          <select
            aria-label="Playback speed"
            value={speed}
            onChange={(event) => setSpeed(Number(event.target.value))}
            className="ml-auto rounded-md border border-line bg-ink-800 px-1.5 py-1 text-xs text-white outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            {SPEEDS.map((value) => <option key={value} value={value}>{value}x</option>)}
          </select>
        </div>
      </div>
      {canComment && (
        <div role="group" aria-label="React at this moment" className="flex flex-wrap gap-0.5 px-3 pt-1">
          {REACTION_EMOJIS.map((emoji) => (
            <button key={emoji} type="button" aria-label={`React ${emoji}`} disabled={busy} onClick={() => react(emoji)} className="grid h-7 w-7 place-items-center rounded-full text-base outline-none transition hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-40">{emoji}</button>
          ))}
        </div>
      )}
      <nav className="flex gap-1 px-3 pt-2" role="tablist" aria-label="Talktrack details">
        {[["overview", "Overview"], ["transcript", "Transcript"], ["comments", `Comments${comments.length ? ` ${comments.length}` : ""}`], ...(canSeeViewers ? [["viewers", "Viewers"]] : []), ...(canEdit ? [["edit", "Edit"]] : [])].map(([value, label]) => (
          <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)} className={cn(TAB, tab === value ? "bg-white/10 text-white" : "text-white/55 hover:text-white")}>{label}</button>
        ))}
      </nav>
      <div role="tabpanel" className="max-h-52 min-h-24 overflow-y-auto px-3 py-2 text-sm text-white/85">
        {tab === "overview" && (
          <div>
            {chapter && <p className="mb-2 text-xs text-white/55">Now: <span className="text-white/85">{chapter.title}</span></p>}
            {(track.chapters || []).length ? (
              <ol className="space-y-0.5">
                {track.chapters.map((item) => (
                  <li key={item.startMs}>
                    <button type="button" onClick={() => seek(item.startMs)} className="flex w-full gap-2 rounded px-1 py-0.5 text-left outline-none hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-brand">
                      <span className="font-mono text-xs tabular-nums text-white/50">{formatTime(item.startMs - window.start)}</span>
                      <span className="min-w-0 flex-1 truncate">{item.title}</span>
                    </button>
                  </li>
                ))}
              </ol>
            ) : <p className="text-xs text-white/55">Chapters appear once a transcript exists.</p>}
          </div>
        )}
        {tab === "transcript" && (
          <div>
            {track.transcript ? (
              segments.length ? (
                <ul className="space-y-0.5">
                  {segments.map((segment, index) => (
                    <li key={index}>
                      <button type="button" onClick={() => seek(segment.startMs)} className={cn("block w-full rounded px-1 py-0.5 text-left text-xs outline-none hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-brand", index === activeSegment && "bg-white/10 text-white")}>
                        <span className="mr-2 font-mono tabular-nums text-white/50">{formatTime(segment.startMs - window.start)}</span>
                        {segment.speaker ? <strong className="mr-1 font-semibold">{segment.speaker}:</strong> : null}{segment.text}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : <p className="text-xs text-white/55">No speech was found.</p>
            ) : (
              <div className="text-xs text-white/65">
                <p>No transcript yet.</p>
                {canEdit && track.hasAudio && transcriptionAvailable ? (
                  <>
                    <p className="mt-1 text-white/50">Creating one sends the audio to the speech service and counts as a paid request.</p>
                    <button type="button" disabled={busy || busyJob} onClick={() => run(() => store.transcribe(track.id), "The transcript could not be made.")} className={cn(SMALL, "mt-2")}>Create transcript</button>
                  </>
                ) : <p className="mt-1 text-white/50">{transcriptionAvailable ? "Only the person who recorded it can create one." : "Transcripts are not set up on this server."}</p>}
              </div>
            )}
          </div>
        )}
        {tab === "comments" && (
          <div>
            {comments.length ? (
              <ul className="space-y-1">
                {comments.map((item) => (
                  <li key={item.id} className="group flex items-start gap-2 rounded px-1 py-0.5 hover:bg-white/5">
                    <button type="button" onClick={() => seek(item.atMs)} className="font-mono text-xs tabular-nums text-white/50 outline-none hover:text-white focus-visible:underline">{formatTime(item.atMs - window.start)}</button>
                    <p className="min-w-0 flex-1 break-words text-xs"><strong className="mr-1 font-semibold text-white">{item.name}</strong>{item.text}</p>
                    {(item.userId === me || canShareRole(role) || track.ownerId === me) && canComment && (
                      <button type="button" aria-label="Delete comment" onClick={() => dropMoment(item)} className="opacity-0 outline-none transition focus-visible:opacity-100 group-hover:opacity-100"><Trash2 className="h-3.5 w-3.5 text-white/60" /></button>
                    )}
                  </li>
                ))}
              </ul>
            ) : <p className="text-xs text-white/55">No comments yet.</p>}
            {canComment ? (
              <form className="mt-2 flex gap-1.5" onSubmit={(event) => { event.preventDefault(); comment(); }}>
                <input aria-label="Comment at this moment" value={text} maxLength={2000} onChange={(event) => setText(event.target.value)} placeholder={`Comment at ${formatTime(nowMs - window.start)}`} className="min-w-0 flex-1 rounded-full border border-line bg-ink-800 px-3 py-1 text-xs text-white outline-none focus:border-brand" />
                <button type="submit" aria-label="Send comment" disabled={busy || !text.trim()} className={ICON_BUTTON}><Send className="h-4 w-4" /></button>
              </form>
            ) : <p className="mt-2 text-xs text-white/50">You can watch but not comment on this board.</p>}
          </div>
        )}
        {tab === "viewers" && (
          <div>
            {!viewers ? <p className="text-xs text-white/55">Loading...</p> : (
              <>
                <p className="text-xs text-white/70" data-talktrack-viewers-summary="">{viewersSummary(viewers.totals)}</p>
                <ul className="mt-1 space-y-0.5">
                  {viewers.viewers.map((item) => (
                    <li key={item.userId} className="flex items-center gap-2 text-xs">
                      <span className="min-w-0 flex-1 truncate">{item.name}</span>
                      <span className="font-mono tabular-nums text-white/50">{formatTime(item.watchedMs)}{item.completed ? " · done" : ""}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
        {tab === "edit" && canEdit && (
          <div className="space-y-3 text-xs">
            <div>
              <p className="font-semibold text-white">Trim</p>
              <p className="text-white/55">Hide the start or end. The file is not changed and you can undo it.</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <button type="button" disabled={busy || nowMs >= window.end - 1000} onClick={() => run(() => store.trim(track.id, bounds.min, track.trimEndMs), "That trim was not saved.")} className={SMALL}>Start here</button>
                <button type="button" disabled={busy || nowMs <= window.start + 1000} onClick={() => run(() => store.trim(track.id, track.trimStartMs, bounds.min), "That trim was not saved.")} className={SMALL}>End here</button>
                <button type="button" disabled={busy || (window.start === 0 && window.end === track.durationMs)} onClick={() => run(() => store.trim(track.id, 0, track.durationMs), "That trim was not saved.")} className={SMALL}>Reset trim</button>
              </div>
            </div>
            <div>
              <p className="font-semibold text-white">Cut out a section</p>
              <p className="text-white/55">Removes the middle for good and joins the two sides.</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <button type="button" onClick={() => setMark((value) => ({ ...value, start: bounds.min }))} className={SMALL}>Mark start</button>
                <button type="button" onClick={() => setMark((value) => ({ ...value, end: bounds.min }))} className={SMALL}>Mark end</button>
                <span className="font-mono tabular-nums text-white/60" data-talktrack-cut-range="">
                  {mark.start != null ? formatTime(mark.start) : "--"} to {mark.end != null ? formatTime(mark.end) : "--"}
                </span>
                <button
                  type="button"
                  data-talktrack-cut=""
                  disabled={busy || busyJob || mark.start == null || mark.end == null || mark.end - mark.start < 500}
                  onClick={() => run(async () => { await store.cut(track.id, mark.start, mark.end); setMark({ start: null, end: null }); }, "The cut could not start.")}
                  className={SMALL}
                >
                  Cut out
                </button>
              </div>
              {track.status === "failed" && <p className="mt-1 text-red-300">Processing failed. The recording is unchanged.</p>}
            </div>
          </div>
        )}
        {message && <p role="alert" className="mt-2 text-xs text-red-300">{message}</p>}
      </div>
    </aside>
  );
}
