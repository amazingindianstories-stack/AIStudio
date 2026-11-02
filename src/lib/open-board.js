"use client";

import { useEffect } from "react";

const EVENT = "veevee:open-board";

/** Asks the board screen to open another board (and the project it belongs to). */
export function requestOpenBoard(boardId, projectId) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(EVENT, { detail: { boardId, projectId } }));
}

/** Calls `open(boardId, projectId)` whenever something asks to open a board. */
export function useOpenBoardRequests(open) {
  useEffect(() => {
    const handler = (e) => {
      const { boardId, projectId } = e.detail ?? {};
      if (typeof boardId === "string") open(boardId, projectId);
    };
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, [open]);
}
