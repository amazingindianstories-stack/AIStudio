import { create } from "zustand";
import { captureErrorMessage, recordingSupported, startRecording } from "./talktrack-recorder";
import { MIN_RECORDING_MS, nextRecorderState } from "./talktrack";
import { useTalktrackStore } from "./talktrack-store";

const COUNTDOWN_FROM = 3;
let controller = null;
let countdownTimer = null;
let tickTimer = null;

/**
 * The recording in progress: idle, a 3 second countdown, recording, paused, then saving. The recorder itself
 * is module state (a MediaRecorder cannot live in a store); the store holds only what the interface shows.
 */
export const useTalktrackRecording = create((set, get) => ({
  state: "idle",
  source: "screen",
  countdown: 0,
  elapsedMs: 0,
  error: "",
  supported: true,

  checkSupport() {
    set({ supported: recordingSupported() });
  },
  setSource(source) {
    if (get().state === "idle") set({ source });
  },

  /** Counts down, asks the browser for the screen or camera, then records. Cancelling the pick returns to idle. */
  start() {
    if (get().state !== "idle") return;
    set({ state: nextRecorderState("idle", "start"), countdown: COUNTDOWN_FROM, error: "", elapsedMs: 0 });
    const step = () => {
      const left = get().countdown - 1;
      if (left > 0) {
        set({ countdown: left });
        countdownTimer = setTimeout(step, 1000);
        return;
      }
      countdownTimer = null;
      get().begin();
    };
    countdownTimer = setTimeout(step, 1000);
  },
  cancelCountdown() {
    clearTimeout(countdownTimer);
    countdownTimer = null;
    set({ state: nextRecorderState(get().state, "cancel"), countdown: 0 });
  },
  async begin() {
    try {
      controller = await startRecording({ source: get().source, onEnded: () => get().stop() });
    } catch (error) {
      controller = null;
      set({ state: "idle", countdown: 0, error: captureErrorMessage(error) });
      return;
    }
    set({ state: nextRecorderState("countdown", "go"), countdown: 0 });
    clearInterval(tickTimer);
    tickTimer = setInterval(() => set({ elapsedMs: controller ? controller.elapsed() : 0 }), 250);
  },
  pause() {
    if (get().state !== "recording" || !controller) return;
    controller.pause();
    set({ state: nextRecorderState("recording", "pause"), elapsedMs: controller.elapsed() });
  },
  resume() {
    if (get().state !== "paused" || !controller) return;
    controller.resume();
    set({ state: nextRecorderState("paused", "resume") });
  },
  /** Stops, uploads and registers the recording. Resolves the saved Talktrack, or null when nothing was kept. */
  async stop() {
    const state = get().state;
    if (state !== "recording" && state !== "paused") return null;
    const running = controller;
    controller = null;
    clearInterval(tickTimer);
    set({ state: nextRecorderState(state, "stop") });
    try {
      const result = await running.stop();
      if (!result?.video || result.durationMs < MIN_RECORDING_MS) {
        set({ state: nextRecorderState("saving", "fail"), error: "That recording was too short to keep." });
        return null;
      }
      const stamp = new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
      const saved = await useTalktrackStore.getState().save({ ...result, title: `Talktrack ${stamp}` });
      set({ state: nextRecorderState("saving", "done"), elapsedMs: 0 });
      useTalktrackStore.getState().play(saved.id);
      return saved;
    } catch (error) {
      set({ state: nextRecorderState("saving", "fail"), error: error?.message || "The recording could not be saved." });
      return null;
    }
  },
  /** Leaving the board discards a recording that is not saved yet. */
  discard() {
    clearTimeout(countdownTimer);
    clearInterval(tickTimer);
    countdownTimer = null;
    if (controller) controller.cancel();
    controller = null;
    set({ state: "idle", countdown: 0, elapsedMs: 0 });
  },
  clearError() {
    set({ error: "" });
  },
}));
