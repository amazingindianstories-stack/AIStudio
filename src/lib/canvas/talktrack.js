/** Pure helpers for Talktrack: recording formats, the trimmed playback window, the timeline and transcripts. */

export const SPEEDS = [0.5, 1, 1.25, 1.5, 2];
export const SKIP_MS = 10000;
export const REACTION_EMOJIS = ["👍", "❤️", "😂", "🎉", "👏", "🤔", "🔥", "👀"];
/** A recording this short is a mis-click; the server also keeps at least one second of any trim. */
export const MIN_RECORDING_MS = 1000;
export const MAX_RECORDING_MS = 60 * 60 * 1000;

const VIDEO_TYPES = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
const AUDIO_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

function firstSupported(types, MediaRecorderImpl) {
  if (!MediaRecorderImpl?.isTypeSupported) return null;
  return types.find((type) => MediaRecorderImpl.isTypeSupported(type)) || null;
}

/** The container the browser can record to: the video and the audio-only twin used for transcription. */
export function pickRecordingTypes(MediaRecorderImpl = globalThis.MediaRecorder) {
  return { video: firstSupported(VIDEO_TYPES, MediaRecorderImpl), audio: firstSupported(AUDIO_TYPES, MediaRecorderImpl) };
}

/** `m:ss` (or `h:mm:ss`) for a time in milliseconds; never negative. */
export function formatTime(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** The part of the file that plays: the trim offsets clamped to the recording. */
export function playbackWindow(track) {
  const duration = Math.max(0, track?.durationMs || 0);
  const start = Math.min(Math.max(0, track?.trimStartMs || 0), duration);
  const end = Math.min(track?.trimEndMs ?? duration, duration);
  return { start, end: Math.max(start, end), length: Math.max(0, end - start) };
}

/** Where a skip lands, kept inside the playback window. */
export function skipTo(currentMs, deltaMs, window) {
  return Math.min(window.end, Math.max(window.start, currentMs + deltaMs));
}

/** Position on the timeline (0 to 1) of a file time, relative to the playback window. */
export function timelineFraction(ms, window) {
  if (!window.length) return 0;
  return Math.min(1, Math.max(0, (ms - window.start) / window.length));
}

/** The file time under a pointer at `fraction` of the timeline. */
export function timeAtFraction(fraction, window) {
  return Math.round(window.start + Math.min(1, Math.max(0, fraction)) * window.length);
}

/** Reactions grouped into timeline buckets so a busy moment shows one marker with a count. Comments are not reactions. */
export function reactionBuckets(moments, window, buckets = 40) {
  if (!window.length) return [];
  const grouped = new Map();
  for (const moment of moments || []) {
    if (!moment.emoji || moment.atMs < window.start || moment.atMs > window.end) continue;
    const index = Math.min(buckets - 1, Math.floor(timelineFraction(moment.atMs, window) * buckets));
    const bucket = grouped.get(index) || { index, atMs: moment.atMs, emojis: new Map(), count: 0 };
    bucket.emojis.set(moment.emoji, (bucket.emojis.get(moment.emoji) || 0) + 1);
    bucket.count += 1;
    grouped.set(index, bucket);
  }
  return [...grouped.values()]
    .sort((a, b) => a.index - b.index)
    .map((bucket) => ({
      index: bucket.index,
      atMs: bucket.atMs,
      count: bucket.count,
      fraction: (bucket.index + 0.5) / buckets,
      top: [...bucket.emojis.entries()].sort((a, b) => b[1] - a[1])[0][0],
    }));
}

/** The chapter playing at `ms`, or null before the first. */
export function chapterAt(chapters, ms) {
  let found = null;
  for (const chapter of chapters || []) {
    if (chapter.startMs <= ms) found = chapter;
    else break;
  }
  return found;
}

/** The transcript segment spoken at `ms`: the last one that has started. */
export function segmentIndexAt(segments, ms) {
  let found = -1;
  (segments || []).forEach((segment, index) => {
    if (segment.startMs <= ms) found = index;
  });
  return found;
}

/**
 * A chain of recorder states for the control bar: idle, countdown, recording, paused, saving.
 * Pause and resume only move between recording and paused.
 */
export function nextRecorderState(state, event) {
  const table = {
    idle: { start: "countdown" },
    countdown: { go: "recording", cancel: "idle" },
    recording: { pause: "paused", stop: "saving" },
    paused: { resume: "recording", stop: "saving" },
    saving: { done: "idle", fail: "idle" },
  };
  return table[state]?.[event] || state;
}

/** Elapsed recording time that leaves out paused spans. */
export function recordedMs({ startedAt, pausedTotal = 0, pausedAt = null }, now) {
  if (startedAt == null) return 0;
  return Math.max(0, (pausedAt ?? now) - startedAt - pausedTotal);
}

/** How much of the recording this person has watched, as a share of the playback window. */
export function watchedShare(watchedMs, track) {
  const { length } = playbackWindow(track);
  return length ? Math.min(1, Math.max(0, watchedMs / track.durationMs)) : 0;
}

/** Who has seen a recording, for the viewers summary line. */
export function viewersSummary(totals) {
  if (!totals?.viewers) return "No views yet";
  const done = totals.completed ? `, ${totals.completed} watched to the end` : "";
  return `${totals.viewers} ${totals.viewers === 1 ? "person has" : "people have"} watched${done}`;
}
