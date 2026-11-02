import { create } from "zustand";
import { apiFetch } from "../api";
import { uploadFileDirect } from "../client-reference-upload";

async function call(path, method = "GET", body) {
  const res = await apiFetch(path, {
    method,
    cache: "no-store",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed: ${res.status}`);
  return json;
}

const base = (boardId, id = "") => `/api/canvas-boards/${boardId}/talktracks${id ? `/${id}` : ""}`;
const replaceIn = (list, track) => list.map((item) => (item.id === track.id ? { ...item, ...track } : item));

/**
 * Talktrack recordings of the open board and the signed-in person's own recordings across boards, plus the
 * recording being played. Recording itself lives in talktrack-recorder.js; this store only talks to the server.
 */
export const useTalktrackStore = create((set, get) => ({
  boardId: null,
  tracks: [],
  loaded: false,
  error: "",
  transcriptionAvailable: false,
  mine: [],
  mineLoaded: false,
  /** The id of the recording open in the player. */
  playingId: null,
  /** In flight: "uploading" while a new recording is being saved. */
  saving: null,

  open(boardId) {
    if (get().boardId !== boardId) set({ boardId, tracks: [], loaded: false, error: "", playingId: null, saving: null });
  },
  close() {
    set({ boardId: null, tracks: [], loaded: false, playingId: null });
  },
  play(id) {
    set({ playingId: id });
  },

  async load() {
    const boardId = get().boardId;
    if (!boardId) return;
    try {
      const json = await call(base(boardId));
      if (get().boardId !== boardId) return;
      set({ tracks: json.talktracks || [], loaded: true, error: "", transcriptionAvailable: Boolean(json.transcriptionAvailable) });
    } catch (error) {
      if (get().boardId === boardId) set({ error: error.message, loaded: true });
    }
  },
  async loadMine() {
    try {
      const json = await call("/api/my-talktracks");
      set({ mine: json.talktracks || [], mineLoaded: true });
    } catch {
      set({ mineLoaded: true });
    }
  },

  /** Uploads the finished recording (and its audio twin) through the media upload path, then registers it. */
  async save({ video, audio, durationMs, title }) {
    const boardId = get().boardId;
    if (!boardId || !video) throw new Error("There is nothing to save.");
    set({ saving: "uploading" });
    try {
      const file = new File([video], "talktrack." + (video.type.includes("mp4") ? "mp4" : "webm"), { type: video.type });
      const uploaded = await uploadFileDirect(file, "talktrack");
      let audioReferenceId;
      if (audio && audio.size > 0 && audio.size <= 15 * 1024 * 1024) {
        try {
          const audioFile = new File([audio], "talktrack-audio." + (audio.type.includes("mp4") ? "m4a" : "webm"), { type: audio.type });
          audioReferenceId = (await uploadFileDirect(audioFile, "talktrack")).referenceId;
        } catch {
          // The recording is kept without a transcript source rather than lost.
        }
      }
      const json = await call(base(boardId), "POST", { referenceId: uploaded.referenceId, audioReferenceId, durationMs, title });
      if (get().boardId === boardId) set((state) => ({ tracks: [json.talktrack, ...state.tracks] }));
      return json.talktrack;
    } finally {
      set({ saving: null });
    }
  },

  async patch(id, body) {
    const boardId = get().boardId;
    const json = await call(base(boardId, id), "PATCH", body);
    set((state) => ({ tracks: replaceIn(state.tracks, json.talktrack), mine: replaceIn(state.mine, json.talktrack) }));
    return json.talktrack;
  },
  rename(id, title) {
    return get().patch(id, { title });
  },
  trim(id, trimStartMs, trimEndMs, durationMs) {
    return get().patch(id, { trimStartMs, trimEndMs, durationMs });
  },
  cut(id, startMs, endMs, durationMs) {
    return get().patch(id, { cut: { startMs, endMs }, durationMs });
  },
  async remove(id, boardId = get().boardId) {
    await call(base(boardId, id), "DELETE");
    set((state) => ({
      tracks: state.tracks.filter((item) => item.id !== id),
      mine: state.mine.filter((item) => item.id !== id),
      playingId: state.playingId === id ? null : state.playingId,
    }));
  },
  async refreshOne(id) {
    const boardId = get().boardId;
    const json = await call(base(boardId, id));
    set((state) => ({ tracks: replaceIn(state.tracks, json.talktrack) }));
    return json.talktrack;
  },

  async recordView(id, watchedMs, completed, durationMs) {
    try {
      return await call(base(get().boardId, id) + "/view", "POST", { watchedMs: Math.round(watchedMs), completed: Boolean(completed), durationMs });
    } catch {
      return null;
    }
  },
  viewers(id) {
    return call(base(get().boardId, id) + "/viewers");
  },
  async moments(id) {
    return (await call(base(get().boardId, id) + "/moments")).moments || [];
  },
  async addMoment(id, body) {
    return (await call(base(get().boardId, id) + "/moments", "POST", body)).moment;
  },
  async removeMoment(id, momentId) {
    await call(base(get().boardId, id) + `/moments/${momentId}`, "DELETE");
  },
  async transcribe(id) {
    const json = await call(base(get().boardId, id) + "/transcript", "POST", {});
    set((state) => ({ tracks: replaceIn(state.tracks, json.talktrack) }));
    return json.talktrack;
  },
}));
