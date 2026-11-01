/**
 * Start view: a board owner (or co-owner) can pick the view newly invited
 * people open at (`settings.startView`). "New" means this device has never
 * opened the board, recorded in localStorage; afterwards the board opens at
 * its saved viewport as before.
 */
import { clampZoom } from "./geometry";

const KEY = "veevee.board.seen";
// Keeps the record small: the boards opened most recently on this device.
export const MAX_SEEN_BOARDS = 500;

function readSeen() {
  try {
    const list = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writeSeen(list) {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(list.slice(-MAX_SEEN_BOARDS)));
  } catch {
    /* storage unavailable: every visit counts as the first */
  }
}

export function hasSeenBoard(boardId) {
  return readSeen().includes(String(boardId));
}

export function markBoardSeen(boardId) {
  const id = String(boardId);
  const list = readSeen().filter((seen) => seen !== id);
  list.push(id);
  writeSeen(list);
}

/**
 * The board state to open with: the start view replaces the saved viewport
 * the first time this device opens the board. Records the board as seen.
 * `keepViewport` (a restored local draft) keeps the person's own view.
 */
export function withStartView(boardId, state, { keepViewport = false } = {}) {
  const first = !hasSeenBoard(boardId);
  markBoardSeen(boardId);
  const view = state?.settings?.startView;
  if (!first || keepViewport || !view) return state;
  return { ...state, viewport: { x: view.x, y: view.y, zoom: clampZoom(view.zoom) } };
}
