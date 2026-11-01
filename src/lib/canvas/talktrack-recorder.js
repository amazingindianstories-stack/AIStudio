import { MAX_RECORDING_MS, pickRecordingTypes } from "./talktrack";

/** Why a recording could not start, in words a person can act on. */
export function captureErrorMessage(error) {
  const name = error?.name || "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Recording was blocked. Allow screen, camera and microphone access in the browser and try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera or microphone was found.";
  if (name === "NotSupportedError") return "This browser cannot record. Try a current Chrome, Edge or Firefox.";
  return error?.message || "Recording could not start.";
}

export function recordingSupported(env = globalThis) {
  return Boolean(env.MediaRecorder && env.navigator?.mediaDevices?.getUserMedia);
}

async function openStream(source, media) {
  if (source === "screen") {
    if (!media.getDisplayMedia) throw Object.assign(new Error("Screen recording is not available here."), { name: "NotSupportedError" });
    const screen = await media.getDisplayMedia({ video: true, audio: false });
    let mic = null;
    try {
      mic = await media.getUserMedia({ audio: true, video: false });
    } catch {
      // A screen recording without narration is still useful; the mic is optional.
    }
    return { video: screen, mic, owned: [screen, mic].filter(Boolean) };
  }
  const camera = await media.getUserMedia({ audio: true, video: true });
  return { video: camera, mic: camera, owned: [camera] };
}

/**
 * Starts recording the screen or the camera with MediaRecorder. Alongside the video it records the microphone
 * on its own, a small audio file the transcript is made from. `stop()` resolves the finished files; the
 * browser's own "stop sharing" ends the recording the same way (`onEnded`).
 */
export async function startRecording({ source = "screen", env = globalThis, onEnded, now = () => Date.now() } = {}) {
  const Recorder = env.MediaRecorder;
  const media = env.navigator?.mediaDevices;
  if (!Recorder || !media?.getUserMedia) throw Object.assign(new Error("This browser cannot record."), { name: "NotSupportedError" });
  const types = pickRecordingTypes(Recorder);
  if (!types.video) throw Object.assign(new Error("This browser has no supported recording format."), { name: "NotSupportedError" });
  const { video, mic, owned } = await openStream(source, media);
  const release = () => owned.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
  const stream = new env.MediaStream([...video.getVideoTracks(), ...(mic ? mic.getAudioTracks() : [])]);
  const parts = { video: [], audio: [] };
  const recorders = [];
  const track = (inputStream, mimeType, bucket, bitrate) => {
    const recorder = new Recorder(inputStream, { mimeType, ...bitrate });
    recorder.ondataavailable = (event) => {
      if (event.data?.size) parts[bucket].push(event.data);
    };
    recorders.push(recorder);
    return recorder;
  };
  const videoRecorder = track(stream, types.video, "video", {});
  const micTracks = mic ? mic.getAudioTracks() : [];
  // A low bitrate keeps an hour of speech well under the 15 MB the transcription accepts.
  const audioRecorder = micTracks.length && types.audio
    ? track(new env.MediaStream(micTracks), types.audio, "audio", { audioBitsPerSecond: 24000 })
    : null;
  let startedAt = now();
  let pausedAt = null;
  let pausedTotal = 0;
  let finished = null;
  const elapsed = () => Math.max(0, (pausedAt ?? now()) - startedAt - pausedTotal);
  const settle = (recorder) => new Promise((resolve) => {
    if (recorder.state === "inactive") { resolve(); return; }
    recorder.onstop = () => resolve();
    recorder.stop();
  });
  const stop = () => {
    if (!finished) {
      const durationMs = Math.min(elapsed(), MAX_RECORDING_MS);
      finished = Promise.all(recorders.map(settle)).then(() => {
        release();
        const blob = (bucket, type) => (parts[bucket].length ? new Blob(parts[bucket], { type }) : null);
        return {
          durationMs,
          video: blob("video", types.video.split(";")[0]),
          audio: blob("audio", (types.audio || "audio/webm").split(";")[0]),
        };
      });
    }
    return finished;
  };
  // Chunks arrive every second, so a crash or a long recording never holds everything in one buffer.
  recorders.forEach((recorder) => recorder.start(1000));
  video.getVideoTracks().forEach((videoTrack) => {
    videoTrack.addEventListener?.("ended", () => onEnded?.());
  });
  return {
    elapsed,
    get paused() { return pausedAt !== null; },
    pause() {
      if (pausedAt !== null) return;
      pausedAt = now();
      recorders.forEach((recorder) => recorder.state === "recording" && recorder.pause());
    },
    resume() {
      if (pausedAt === null) return;
      pausedTotal += now() - pausedAt;
      pausedAt = null;
      recorders.forEach((recorder) => recorder.state === "paused" && recorder.resume());
    },
    stop,
    cancel() {
      finished = Promise.resolve(null);
      recorders.forEach((recorder) => { recorder.ondataavailable = null; if (recorder.state !== "inactive") recorder.stop(); });
      release();
    },
    get stream() { return stream; },
    get startedAt() { return startedAt; },
  };
}
