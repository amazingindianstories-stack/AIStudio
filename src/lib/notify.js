"use client";

/** Non-blocking notices. Replaces window.alert, which froze the whole page. */
import { create } from "zustand";

const LIFETIME_MS = 6000;
let nextId = 1;

export const useNotices = create(() => ({ notices: [] }));

export function dismissNotice(id) {
  useNotices.setState((state) => ({ notices: state.notices.filter((notice) => notice.id !== id) }));
}

export function notify(message, { tone = "error" } = {}) {
  const text = typeof message === "string" ? message.trim() : "";
  if (!text) return null;
  const existing = useNotices.getState().notices.find((notice) => notice.text === text);
  if (existing) return existing.id;
  const id = nextId++;
  useNotices.setState((state) => ({ notices: [...state.notices.slice(-3), { id, text, tone }] }));
  if (typeof setTimeout === "function") setTimeout(() => dismissNotice(id), LIFETIME_MS);
  return id;
}
