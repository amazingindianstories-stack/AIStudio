"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "./api";

// Synced copies are references: the board stores which frame on which board, and this module reads that
// frame's current content from the server when the copy is shown and again every REFRESH_MS while it stays on
// screen. Nothing is pushed. The server applies the viewer's own access to the source board, so a copy never
// shows more than its viewer could open there.

export const REFRESH_MS = 30000;

const cache = new Map();

function key(boardId, nodeId) {
  return `${boardId}/${nodeId}`;
}

function path(boardId, nodeId) {
  return `/api/canvas-boards/${encodeURIComponent(boardId)}/frames/${encodeURIComponent(nodeId)}`;
}

/** The source frame as `{ status: "ready", data }`, `{ status: "gone" }` when it is missing or no longer readable, or `{ status: "error" }`. */
export async function fetchSyncedFrame(boardId, nodeId) {
  try {
    const response = await apiFetch(path(boardId, nodeId));
    if (response.status === 404 || response.status === 403) return { status: "gone" };
    if (!response.ok) return { status: "error" };
    return { status: "ready", data: await response.json() };
  } catch {
    return { status: "error" };
  }
}

/** The live-enough content of a synced copy, refreshed on mount and every REFRESH_MS. */
export function useSyncedFrame(boardId, nodeId) {
  const id = key(boardId, nodeId);
  const [result, setResult] = useState(() => cache.get(id) ?? { status: "loading" });
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const next = await fetchSyncedFrame(boardId, nodeId);
      // A failed refresh keeps showing the last good copy.
      if (next.status === "error" && cache.get(id)?.status === "ready") return;
      cache.set(id, next);
      if (alive) setResult(next);
    };
    load();
    const timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") load();
    }, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [boardId, nodeId, id]);
  return result;
}

/** The frames of another board a person can copy from: `{ board, frames }`, or null when it cannot be opened. */
export async function listFrames(boardId) {
  try {
    const response = await apiFetch(`/api/canvas-boards/${encodeURIComponent(boardId)}/frames`);
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/** Boards holding a synced copy of a frame, for the "list of copies" next to the original. */
export async function listCopies(boardId, nodeId) {
  try {
    const response = await apiFetch(`${path(boardId, nodeId)}/copies`);
    if (!response.ok) return [];
    return (await response.json()).copies ?? [];
  } catch {
    return [];
  }
}

export function clearSyncedCache() {
  cache.clear();
}
