"use client";

import { create } from "zustand";
import * as api from "./comments-api";
import { loadPref, mergeComments, newestUpdate, savePref } from "./comments.js";

/**
 * The open board's comments, who is on it and the bell's unread count. The server owns the data
 * (comments live beside the board JSON); this store holds what the last load or poll returned plus
 * the view state of this browser: placing a comment, the open thread, pinned threads, hidden comments.
 */
const initial = {
  boardId: null,
  comments: new Map(),
  follows: { all: false, threads: [] },
  people: [],
  unread: 0,
  since: 0,
  status: "idle",
  error: null,
  placing: false,
  openThreadId: null,
  panelOpen: false,
  hidden: false,
  showResolved: false,
  pinned: [],
  suggested: [],
};

const fold = (state, comments, since) => ({ comments: mergeComments(state.comments, comments), since: Math.max(state.since, newestUpdate(comments, since ?? 0)) });

export const useCommentsStore = create((set, get) => ({
  ...initial,

  /** Open `boardId`: forget the last board's comments and load this one's. */
  async open(boardId) {
    set({ ...initial, boardId, status: "loading", hidden: loadPref(boardId, "hidden", false), showResolved: loadPref(boardId, "resolved", false), pinned: loadPref(boardId, "pinned", []) });
    try {
      const { comments, follows } = await api.fetchComments(boardId);
      if (get().boardId !== boardId) return;
      set((state) => ({ ...fold(state, comments), follows, status: "ready" }));
    } catch (error) {
      if (get().boardId === boardId) set({ status: "error", error: error.message });
    }
    void api.fetchMentionSuggestions(boardId).then(({ userIds }) => get().boardId === boardId && set({ suggested: userIds })).catch(() => {});
  },

  close() {
    set({ ...initial });
  },

  /** One poll: presence beat, people here, comments changed since the last one, unread count. Resolves true when comments changed. */
  async pulse() {
    const { boardId, since } = get();
    if (!boardId) return false;
    try {
      const result = await api.pulseBoard(boardId, since);
      if (get().boardId !== boardId) return false;
      const changed = result.comments.length > 0 && result.comments.some((comment) => comment.updatedAt > since);
      set((state) => ({ ...fold(state, result.comments), people: result.people, unread: result.unread }));
      return changed;
    } catch {
      return false;
    }
  },

  setPlacing: (placing) => set({ placing, openThreadId: placing ? null : get().openThreadId }),
  /** Opening a thread (from a pin, the panel or the bell) reads it. */
  openThread(openThreadId) {
    set({ openThreadId, placing: false });
    if (!openThreadId) return;
    const unread = [...get().comments.values()].filter((comment) => (comment.id === openThreadId || comment.parentId === openThreadId) && !comment.read);
    if (unread.length) void get().markRead({ ids: unread.map((comment) => comment.id) });
  },
  setPanelOpen: (panelOpen) => set({ panelOpen }),
  setHidden(hidden) {
    savePref(get().boardId, "hidden", hidden);
    set({ hidden, ...(hidden ? { placing: false, openThreadId: null } : {}) });
  },
  setShowResolved(showResolved) {
    savePref(get().boardId, "resolved", showResolved);
    set({ showResolved });
  },
  togglePinned(id) {
    const pinned = get().pinned.includes(id) ? get().pinned.filter((item) => item !== id) : [...get().pinned, id];
    savePref(get().boardId, "pinned", pinned);
    set({ pinned });
  },

  /** Post a new thread (`anchor` from threadAnchor) or a reply (`parentId`); resolves with the saved comment. */
  async post(data) {
    const { boardId } = get();
    const { comment } = await api.createComment(boardId, data);
    set((state) => fold(state, [comment]));
    if (!comment.parentId) set({ openThreadId: comment.id, placing: false });
    return comment;
  },
  async edit(id, data) {
    const { comment } = await api.updateComment(get().boardId, id, data);
    set((state) => fold(state, [comment]));
  },
  async remove(id) {
    await api.deleteComment(get().boardId, id);
    set((state) => {
      const comments = new Map(state.comments);
      for (const [key, comment] of comments) if (key === id || comment.parentId === id) comments.delete(key);
      return { comments, openThreadId: state.openThreadId === id ? null : state.openThreadId };
    });
  },
  async resolve(id, resolved) {
    const { comment } = await api.resolveComment(get().boardId, id, resolved);
    set((state) => fold(state, [comment]));
  },
  async react(id, emoji) {
    const { comment } = await api.reactToComment(get().boardId, id, emoji);
    set((state) => fold(state, [comment]));
  },

  /** Mark comments read (all of them, or `ids`) or unread, and reflect it here at once. */
  async markRead({ ids = null, unread = false } = {}) {
    const { boardId } = get();
    set((state) => {
      const comments = new Map(state.comments);
      for (const [key, comment] of comments) if (!ids || ids.includes(key)) comments.set(key, { ...comment, read: !unread });
      return { comments };
    });
    try {
      await api.markCommentsRead(boardId, ids ? { ids, unread } : { all: true });
    } catch {
      // The next poll or load restores the server's view.
    }
  },
  async follow(threadId, follow) {
    const { boardId, follows } = get();
    const next = threadId
      ? { ...follows, threads: follow ? [...new Set([...follows.threads, threadId])] : follows.threads.filter((id) => id !== threadId) }
      : { ...follows, all: follow };
    set({ follows: next });
    try {
      await api.followComments(boardId, { threadId, follow });
    } catch {
      set({ follows });
    }
  },
}));
