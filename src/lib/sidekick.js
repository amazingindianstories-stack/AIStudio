import { create } from "zustand";
import { markBoardAiPlaced } from "./board-ai";
import { useCanvasStore } from "./canvas-store";
import { applyActions, summarize } from "./canvas/sidekick-actions";
import * as api from "./sidekick-api";

// Sidekick chat on a board. The catalogue (premade, own and shared Sidekicks, slash-command skills) and the user's
// AI credits are personal; chats are per user and board. A turn is quoted first, then submitted on an explicit send
// (one Idempotency-Key per message, reused on retry), then polled; the answer's actions are applied to the board
// as one undo step and recorded on the job so a reload never applies them twice. Nothing here runs a paid job by itself.


/** A leading "/skill" with the text after it, or null. `skills` is the catalogue's list of `{ name, description, prompt }`. */
export function parseSlash(message, skills = []) {
  const match = /^\/([a-z-]+)(?:\s+([\s\S]*))?$/i.exec(message.trim());
  if (!match) return null;
  const skill = skills.find((item) => item.name === match[1].toLowerCase());
  return skill ? { skill, rest: (match[2] ?? "").trim() } : null;
}

/** The text actually sent: a skill's instruction followed by whatever the person added. */
export function expandMessage(message, skills = []) {
  const slash = parseSlash(message, skills);
  if (!slash) return message.trim();
  return slash.rest ? `${slash.skill.prompt}\n\n${slash.rest}` : slash.skill.prompt;
}

/** Slash-menu matches for a draft that starts with "/". */
export function slashMatches(draft, skills = []) {
  const match = /^\/([a-z-]*)$/i.exec(draft);
  if (!match) return [];
  return skills.filter((skill) => skill.name.startsWith(match[1].toLowerCase()));
}

let pollGeneration = 0;

export const useSidekick = create((set, get) => ({
  boardId: null,
  catalogue: null,
  credits: null,
  chats: [],
  chatId: null,
  sidekickId: "ux-researcher",
  turns: [],
  quote: null,
  sending: false,
  error: null,
  pendingKey: null,

  attach: async (boardId) => {
    pollGeneration += 1;
    set({ boardId, chats: [], chatId: null, turns: [], quote: null, error: null, sending: false, pendingKey: null });
    await Promise.all([get().loadCatalogue(), get().loadCredits(), get().loadChats()]);
  },

  detach: () => {
    pollGeneration += 1;
    set({ boardId: null, chats: [], chatId: null, turns: [], quote: null, error: null, sending: false });
  },

  loadCatalogue: async () => {
    try {
      set({ catalogue: await api.fetchCatalogue() });
    } catch (error) {
      set({ error: error.message });
    }
  },

  loadCredits: async () => {
    try {
      set({ credits: await api.fetchCredits() });
    } catch {
      /* the chip keeps its last figure */
    }
  },

  loadChats: async () => {
    const { boardId } = get();
    if (!boardId) return;
    try {
      const chats = await api.fetchChats(boardId);
      if (get().boardId === boardId) set({ chats });
    } catch (error) {
      set({ error: error.message });
    }
  },

  chooseSidekick: (sidekickId) => set({ sidekickId, chatId: null, turns: [], quote: null, error: null }),

  /** Open a saved chat: its Sidekick and history. */
  openChat: async (chatId) => {
    const { boardId } = get();
    pollGeneration += 1;
    try {
      const { chat, turns } = await api.openChat(boardId, chatId);
      set({ chatId: chat.id, sidekickId: chat.sidekick, turns, quote: null, error: null });
      for (const turn of turns) if (["queued", "running"].includes(turn.status)) void get().follow(turn.id);
    } catch (error) {
      set({ error: error.message });
    }
  },

  newChat: () => {
    pollGeneration += 1;
    set({ chatId: null, turns: [], quote: null, error: null, pendingKey: null });
  },

  deleteChat: async (chatId) => {
    const { boardId } = get();
    try {
      await api.removeChat(boardId, chatId);
      set((s) => ({ chats: s.chats.filter((chat) => chat.id !== chatId), ...(s.chatId === chatId ? { chatId: null, turns: [], quote: null } : {}) }));
    } catch (error) {
      set({ error: error.message });
    }
  },

  /** The chat for the next message: the open one, or a new one with the chosen Sidekick. */
  ensureChat: async () => {
    const { boardId, chatId, sidekickId } = get();
    if (chatId) return chatId;
    const chat = await api.createChat(boardId, sidekickId);
    set((s) => ({ chatId: chat.id, chats: [chat, ...s.chats] }));
    return chat.id;
  },

  requestFor: (message, options = {}) => {
    const { catalogue } = get();
    const selection = useCanvasStore.getState().selection;
    return { message: expandMessage(message, catalogue?.skills), selection, ...options };
  },

  /** The price of sending `message` now (null on a new chat until the first send: it uses the Sidekick's own rate). */
  estimate: async (message, options) => {
    const { boardId, chatId } = get();
    if (!boardId || !message.trim()) return set({ quote: null });
    try {
      const id = chatId ?? (await get().ensureChat());
      const quote = await api.quoteTurn(boardId, id, get().requestFor(message, options));
      if (get().boardId === boardId) set({ quote, error: null });
    } catch (error) {
      set({ quote: null, error: error.message });
    }
  },

  send: async (message, options) => {
    const { boardId, sending } = get();
    if (!boardId || sending || !message.trim()) return null;
    set({ sending: true, error: null });
    try {
      const chatId = await get().ensureChat();
      const request = get().requestFor(message, options);
      const fingerprint = JSON.stringify([chatId, request]);
      const key = get().pendingKey?.fingerprint === fingerprint ? get().pendingKey.key : crypto.randomUUID();
      set({ pendingKey: { fingerprint, key } });
      const job = await api.submitTurn(boardId, chatId, request, key);
      set((s) => ({ turns: [...s.turns, job], quote: null, sending: false, pendingKey: null }));
      void get().follow(job.id);
      void get().loadCredits();
      return job;
    } catch (error) {
      set({ sending: false, error: error.message });
      if (error.code === "AI_CREDITS_EXHAUSTED") void get().loadCredits();
      return null;
    }
  },

  /** Poll one turn until it ends, then apply its actions. */
  follow: async (jobId) => {
    const { boardId } = get();
    const mine = pollGeneration;
    try {
      const job = await api.waitForJob(boardId, jobId, { signal: { get aborted() { return mine !== pollGeneration; } } });
      if (mine !== pollGeneration) return;
      set((s) => ({ turns: s.turns.map((turn) => (turn.id === job.id ? job : turn)) }));
      void get().loadCredits();
      if (job.status === "succeeded") await get().apply(job);
      else if (!job.placedAt) markBoardAiPlaced(boardId, job.id, []).catch(() => {});
    } catch (error) {
      if (error.name !== "AbortError" && mine === pollGeneration) set({ error: error.message });
    }
  },

  /** Apply an answer's actions to the board, once: a job that already records placed ids is left alone. */
  apply: async (job) => {
    const { boardId } = get();
    const actions = job.result?.actions ?? [];
    if (job.placedAt || !actions.length) {
      if (!job.placedAt) markBoardAiPlaced(boardId, job.id, []).catch(() => {});
      return null;
    }
    const canvas = useCanvasStore.getState();
    let outcome = null;
    canvas.editBoard((present) => {
      outcome = applyActions(present, actions, { center: canvas.viewportCenter() });
      return outcome.next;
    });
    if (!outcome || outcome.next === undefined) return null;
    const note = summarize(outcome);
    set((s) => ({ turns: s.turns.map((turn) => (turn.id === job.id ? { ...turn, placedAt: Date.now(), placedNodeIds: outcome.added, applied: note } : turn)) }));
    markBoardAiPlaced(boardId, job.id, outcome.added).catch(() => {});
    return outcome;
  },

  dismissError: () => set({ error: null }),
}));
