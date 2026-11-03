/** Agents tab voice notes: record with MediaRecorder, send the raw audio to the transcribe endpoint, return the text. */

import { apiErrorMessage } from "./api-error";
import { pickRecordingTypes } from "./canvas/talktrack";

/** Shorter than this is a mis-tap; the server refuses a zero-length note anyway. */
export const MIN_VOICE_MS = 500;
const TICK_MS = 250;

export class VoiceNoteError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** The message for a recording failure, by DOMException name: permission, no device, a busy device, or a generic one. */
export function voiceErrorMessage(error) {
  if (error instanceof VoiceNoteError) return error.message;
  switch (error?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Microphone access is blocked. Allow the microphone for this site in the browser settings, then try again.";
    case "NotFoundError":
    case "OverconstrainedError":
      return "No microphone was found. Connect one and try again.";
    case "NotReadableError":
    case "AbortError":
      return "The microphone is in use by another app. Close it and try again.";
    default:
      return "Recording failed. Try again.";
  }
}

export function transcribeUrl(conversationId) {
  return `/api/agent-conversations/${encodeURIComponent(conversationId)}/transcribe`;
}

async function call(fetchImpl, url, options, code, fallback) {
  try {
    return await fetchImpl(url, options);
  } catch {
    throw new VoiceNoteError(code, fallback);
  }
}

/** The caps the server enforces for this user, read before each recording: `{ maxSeconds, maxBytes }`. */
export async function voiceCaps(conversationId, { fetchImpl = fetch } = {}) {
  const response = await call(fetchImpl, transcribeUrl(conversationId), { credentials: "same-origin", cache: "no-store" },
    "caps", "Veevee could not be reached. Check the connection and try again.");
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new VoiceNoteError("caps", apiErrorMessage(body, response.status, "Voice input is unavailable right now."));
  if (!(body.maxSeconds > 0) || !(body.maxBytes > 0)) throw new VoiceNoteError("caps", "Voice input is unavailable right now.");
  return { maxSeconds: body.maxSeconds, maxBytes: body.maxBytes };
}

/**
 * Starts recording the microphone. Resolves to `{ done, stop, cancel }` once recording runs: `done` resolves to
 * `{ blob, durationMs }` after `stop()` or at `maxMs`, or to null after `cancel()`. `onTick(elapsedMs)` fires while
 * recording. Throws VoiceNoteError 'unsupported' without MediaRecorder or getUserMedia; a denied permission rejects
 * with the browser's DOMException (see voiceErrorMessage).
 */
export async function startVoiceNote({
  maxMs, onTick,
  mediaDevices = globalThis.navigator?.mediaDevices, MediaRecorderImpl = globalThis.MediaRecorder,
  now = () => Date.now(), timers = globalThis,
} = {}) {
  if (typeof mediaDevices?.getUserMedia !== "function" || typeof MediaRecorderImpl !== "function") {
    throw new VoiceNoteError("unsupported", "This browser cannot record audio. Use a current Chrome, Edge, Firefox or Safari.");
  }
  const stream = await mediaDevices.getUserMedia({ audio: true });
  const release = () => stream.getTracks().forEach((track) => track.stop());
  let recorder;
  try {
    const type = pickRecordingTypes(MediaRecorderImpl).audio;
    recorder = new MediaRecorderImpl(stream, type ? { mimeType: type } : undefined);
    recorder.start(TICK_MS * 4);
  } catch {
    release();
    throw new VoiceNoteError("unsupported", "This browser cannot record audio. Use a current Chrome, Edge, Firefox or Safari.");
  }
  const chunks = [];
  const startedAt = now();
  let cancelled = false;
  let stoppedAt = null;
  const elapsed = () => Math.min(maxMs, (stoppedAt ?? now()) - startedAt);
  const stop = () => {
    if (recorder.state === "inactive") return;
    stoppedAt ??= now();
    recorder.stop();
  };
  const ticker = timers.setInterval(() => onTick?.(elapsed()), TICK_MS);
  const limit = timers.setTimeout(stop, maxMs);
  const done = new Promise((resolve, reject) => {
    recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
    recorder.onerror = (event) => { finish(); reject(event.error || new VoiceNoteError("failed", "Recording failed. Try again.")); };
    recorder.onstop = () => {
      finish();
      if (cancelled) return resolve(null);
      const durationMs = elapsed();
      if (durationMs < MIN_VOICE_MS || !chunks.length) {
        return reject(new VoiceNoteError("short", "The voice note was too short. Speak a little longer before stopping."));
      }
      resolve({ blob: new Blob(chunks, { type: recorder.mimeType || chunks[0].type || "audio/webm" }), durationMs });
    };
  });
  function finish() {
    timers.clearInterval(ticker);
    timers.clearTimeout(limit);
    release();
  }
  onTick?.(0);
  return { done, stop, cancel: () => { cancelled = true; stop(); } };
}

/** Sends one recording as the raw body (its own Content-Type, the duration in the query) and returns the transcript. */
export async function transcribeVoiceNote(conversationId, { blob, durationMs }, { maxBytes, fetchImpl = fetch } = {}) {
  if (maxBytes && blob.size > maxBytes) {
    throw new VoiceNoteError("large", `The voice note is larger than ${(maxBytes / (1024 * 1024)).toFixed(0)} MB. Record a shorter one.`);
  }
  const response = await call(fetchImpl, `${transcribeUrl(conversationId)}?durationMs=${Math.round(durationMs)}`, {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": blob.type || "audio/webm" }, body: blob,
  }, "transcribe", "Veevee could not be reached to transcribe the voice note. Check the connection and try again.");
  const body = await response.json().catch(() => ({}));
  if (!response.ok || typeof body.transcript !== "string") {
    throw new VoiceNoteError("transcribe", apiErrorMessage(body, response.status, "Veevee could not transcribe the voice note. Try again."));
  }
  return body.transcript;
}

/** The composer text with the transcript appended for review, separated from existing text by a space or newline. */
export function insertTranscript(text, transcript) {
  const spoken = String(transcript || "").trim();
  if (!spoken) return text;
  if (!text.trim()) return spoken;
  return /\s$/.test(text) ? `${text}${spoken}` : `${text} ${spoken}`;
}
