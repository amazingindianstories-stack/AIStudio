import { referenceAudioLimits } from "./config";

// BytePlus enforces its 30 s clip limit as "<= 30.2"; match what it really accepts.
// Mirrors AUDIO_LIMIT_SLACK_SECONDS in backend/apps/generation/services/enqueue.py.
export const AUDIO_LIMIT_SLACK_SECONDS = 0.2;

/** Seconds of audio in a File/Blob or URL, or null when the browser cannot tell. */
export function measureAudioDuration(source, { timeoutMs = 8000 } = {}) {
  if (typeof Audio === "undefined" || !source) return Promise.resolve(null);
  const objectUrl = typeof source === "string" ? null : URL.createObjectURL(source);
  return new Promise((resolve) => {
    const audio = new Audio();
    let timer = null;
    const finish = (seconds) => {
      clearTimeout(timer);
      audio.removeAttribute("src");
      audio.load();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      resolve(Number.isFinite(seconds) && seconds > 0 ? seconds : null);
    };
    timer = setTimeout(() => finish(null), timeoutMs);
    audio.preload = "metadata";
    audio.onloadedmetadata = () => finish(audio.duration);
    audio.onerror = () => finish(null);
    audio.src = objectUrl || source;
  });
}

export function formatAudioSeconds(seconds) {
  return `${seconds.toFixed(1)}s`;
}

/**
 * Indexes of the clips a submission sends: the @audioN tags the prompt names,
 * or every clip when it names none. Mirrors resolve_references(prompt, uploads,
 * "audio") in backend/apps/generation/references.py.
 */
export function sentAudioIndexes(prompt, count) {
  const named = new Set();
  for (const match of String(prompt || "").matchAll(/@audio([1-9][0-9]*)(?![a-z0-9_-])/gi)) {
    if (Number(match[1]) <= count) named.add(Number(match[1]) - 1);
  }
  return named.size ? [...named].sort((a, b) => a - b) : [...Array(count).keys()];
}

/**
 * Which staged audio notes the model will refuse on length. Unknown durations
 * are left to the server check. Returns null when every measured clip fits.
 */
export function referenceAudioProblem(model, notes = [], prompt = "") {
  const limits = referenceAudioLimits(model);
  if (!limits || !notes.length) return null;
  const rule = `${model} accepts reference audio clips of ${limits.clipMin}-${limits.clipMax}s each and ${limits.totalMax}s in total`;
  const sent = sentAudioIndexes(prompt, notes.length);
  const durations = notes.map((note, index) => (sent.includes(index) && typeof note?.duration === "number" ? note.duration : null));
  const tooLong = [], tooShort = [];
  durations.forEach((seconds, index) => {
    if (seconds === null) return;
    if (seconds > limits.clipMax + AUDIO_LIMIT_SLACK_SECONDS) tooLong.push(index);
    else if (seconds < limits.clipMin - AUDIO_LIMIT_SLACK_SECONDS) tooShort.push(index);
  });
  const named = (indexes, what) => indexes.map((i) => `@audio${i + 1} is ${what}${formatAudioSeconds(durations[i])}`).join(", ");
  if (tooLong.length) return { indexes: tooLong, message: `${named(tooLong, "")} long. ${rule}. Trim it before generating.` };
  if (tooShort.length) return { indexes: tooShort, message: `${named(tooShort, "only ")} long. ${rule}. Use a longer clip.` };
  if (sent.every((index) => durations[index] !== null)) {
    const total = sent.reduce((sum, index) => sum + durations[index], 0);
    if (total > limits.totalMax + AUDIO_LIMIT_SLACK_SECONDS) {
      return { indexes: [], message: `The reference audio adds up to ${formatAudioSeconds(total)}. ${rule}. Shorten or remove a clip.` };
    }
  }
  return null;
}

/** Fill in missing lengths (drafts restored from history) without touching measured notes. */
export async function withAudioDurations(notes = [], measure = measureAudioDuration) {
  const missing = (note) => typeof note?.ref === "string" && typeof note.duration !== "number";
  if (!notes.some(missing)) return notes;
  return Promise.all(notes.map(async (note) => {
    if (!missing(note)) return note;
    const duration = await measure(note.ref);
    return duration ? { ...note, duration } : note;
  }));
}
