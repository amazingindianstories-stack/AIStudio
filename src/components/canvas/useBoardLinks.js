"use client";

import { useCallback, useEffect, useRef } from "react";
import { useStore } from "@/lib/store";
import { useCanvasStore } from "@/lib/canvas-store";
import { useBoardUi } from "@/lib/canvas/board-ui";
import { useBoardPrefs } from "@/lib/canvas/board-prefs";
import { pageObjectLink, withoutLinkParams } from "@/lib/canvas/object-link";

/**
 * Opening boards by reference: a link the page was opened with
 * (`?project=&board=&object=`), or a recent board from the command palette.
 * The project switches first, then the board opens, then the object is
 * centered with a "Go back" prompt to the view before the jump.
 *
 * Also records each opened board in the person's recent boards.
 */
export function useBoardLinks({ boardId, setBoardId }) {
  const pending = useRef(null);

  const openBoard = useCallback(
    (link) => {
      if (!link?.board) return;
      pending.current = link;
      const { activeProjectId, setActiveProject } = useStore.getState();
      if (link.project && link.project !== activeProjectId) setActiveProject(link.project);
      setBoardId(link.board);
      // The same board: its object can be shown right away.
      if (link.board === boardId) showPending();
    },
    [boardId, setBoardId]
  );

  // A link in the address opens once, then leaves the address clean.
  useEffect(() => {
    const link = pageObjectLink();
    if (!link) return;
    window.history.replaceState(window.history.state, "", withoutLinkParams(window.location.href));
    openBoard(link);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loaded = useCanvasStore((s) => s.loaded);
  const loadedBoardId = useCanvasStore((s) => s.boardId);
  const boardName = useCanvasStore((s) => s.boardName);
  const activeProjectId = useStore((s) => s.activeProjectId);

  useEffect(() => {
    if (!loaded || !loadedBoardId || loadedBoardId !== boardId) return;
    if (pending.current?.board === loadedBoardId) showPending();
    else pending.current = null;
  }, [loaded, loadedBoardId, boardId]);

  useEffect(() => {
    if (!loaded || !loadedBoardId || loadedBoardId !== boardId || !activeProjectId) return;
    useBoardPrefs.getState().rememberBoard({ id: loadedBoardId, projectId: activeProjectId, name: boardName });
  }, [loaded, loadedBoardId, boardId, boardName, activeProjectId]);

  function showPending() {
    const link = pending.current;
    pending.current = null;
    if (!link?.object) return;
    const store = useCanvasStore.getState();
    const before = store.history.present.viewport;
    if (store.focusObject(link.object)) useBoardUi.getState().setGoBack(before);
    else useBoardUi.getState().notify("That object is no longer on this board");
  }

  return openBoard;
}

/** Puts the view back where it was before following a link, and drops the prompt. */
export function goBack() {
  const ui = useBoardUi.getState();
  if (!ui.goBack) return;
  useCanvasStore.getState().setViewport(ui.goBack);
  ui.setGoBack(null);
}
