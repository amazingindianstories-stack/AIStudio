import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Plus, Pencil, Trash2, Check, MoreHorizontal, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiFetch, requestJson } from "@/lib/api";
import { Dropdown, MenuItem } from "@/components/Dropdown";

/**
 * Board dropdown (ui-spec §8): list/create/rename/switch, delete gated
 * behind a styled confirm dialog (never a native `confirm()`). Owns the
 * board-metadata list for the active project — `canvas-store.ts` only holds
 * the *content* of whichever single board is loaded. Rendered by CanvasView
 * inside a shared positioning row alongside BoardProjectSelector — this
 * component no longer self-positions (see the "Canvas Project Context Is
 * Misleading" bug report / CanvasView's absolute wrapper).
 */
export function BoardSwitcher({
  projectId,
  boardId,
  onBoardIdChange,
  onLoadingChange,
  onErrorChange,
}

) {
  const [boards, setBoards] = useState([]);
  const [boardsLoading, setBoardsLoading] = useState(Boolean(projectId));
  const [renamingTrigger, setRenamingTrigger] = useState(false);
  const [renamingRowId, setRenamingRowId] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [boardsError, setBoardsError] = useState(false);
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState(null);
  const initializedRequest = useRef(null);
  // Guards against an in-flight fetch for a project the user has since
  // switched away from landing its (stale) result into state — the same
  // class of race `loadGeneration` guards against in canvas-store.ts, just
  // for the board *list* rather than a single board's content.
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!projectId) {
      requestIdRef.current += 1; initializedRequest.current = null;
      setBoards([]); setBoardsLoading(false); setBoardsError(false);
      onLoadingChange?.(false); onBoardIdChange(null);
      return;
    }
    const requestKey = `${projectId}:${loadAttempt}`;
    if (initializedRequest.current === requestKey) return;
    initializedRequest.current = requestKey;
    const requestId = ++requestIdRef.current;
    setBoardsError(false);
    setActionError(null);
    setBoards([]);
    onBoardIdChange(null);
    setBoardsLoading(true);
    onLoadingChange?.(true);
    (async () => {
      try {
        const res = await apiFetch(`/api/canvas-boards?projectId=${encodeURIComponent(projectId)}`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error("Could not load boards");
        const json = await res.json().catch(() => ({}));
        if (requestIdRef.current !== requestId) return; // superseded — a newer project switch happened
        if (!Array.isArray(json.boards)) throw new Error("Invalid board list");
        const list = json.boards;
        setBoards(list);
        onBoardIdChange(list.some((b) => b.id === boardId) ? boardId : list[0]?.id ?? null);
      } catch {
        if (requestIdRef.current !== requestId) return;
        setBoards([]);
        setBoardsError(true);
        onBoardIdChange(null);
      } finally {
        if (requestIdRef.current === requestId) {
          setBoardsLoading(false);
          onLoadingChange?.(false);
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, loadAttempt]);

  useEffect(() => { onErrorChange?.(boardsError); }, [boardsError, onErrorChange]);

  const current = boards.find((b) => b.id === boardId) ?? null;

  const createBoard = async () => {
    if (!projectId || creating || boardsLoading || boardsError) return;
    const requestId = requestIdRef.current;
    setCreating(true);
    setActionError(null);
    try {
      const json = await requestJson("/api/canvas-boards", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "createBoard", projectId, name: "Untitled board" }),
      });
      if (requestId !== requestIdRef.current) return;
      if (!json.board?.id || !Array.isArray(json.boards)) throw new Error("No board was returned. Reload before trying again.");
      setBoards(json.boards);
      onBoardIdChange(json.board.id);
      setRenamingTrigger(true);
    } catch (error) { if (requestId === requestIdRef.current) setActionError(error.message); }
    finally { setCreating(false); }
  };

  const renameBoard = async (id, name) => {
    const requestId = requestIdRef.current;
    try {
    const trimmed = name.trim();
    if (!trimmed) return;
    const res = await apiFetch("/api/canvas-boards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "renameBoard", id, name: trimmed }),
    });
    if (!res.ok) { setActionError("Could not save the change. Reload and try again."); return; }
    const json = await res.json().catch(() => ({}));
    if (requestId !== requestIdRef.current) return;
    if (json.boards) setBoards(json.boards);
    } catch (error) { if (requestId === requestIdRef.current) setActionError(error.message || "Could not save the change."); }
  };

  const deleteBoard = async (id) => {
    const requestId = requestIdRef.current;
    try {
    const res = await apiFetch("/api/canvas-boards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "deleteBoard", id }),
    });
    if (!res.ok) { setActionError("Could not save the change. Reload and try again."); return; }
    const json = await res.json().catch(() => ({}));
    if (requestId !== requestIdRef.current) return;
    const list = json.boards ?? boards.filter((b) => b.id !== id);
    setBoards(list);
    if (boardId === id) {
      if (list[0]) {
        onBoardIdChange(list[0]?.id ?? null);
      } else {
        onBoardIdChange(null);
      }
    }
    } catch (error) { if (requestId === requestIdRef.current) setActionError(error.message || "Could not save the change."); }
  };

  return (
    <>
      {actionError && <p role="alert" className="text-sm text-red-300">{actionError}</p>}
      {boardsError ? (
        <button
          type="button"
          onClick={() => setLoadAttempt((attempt) => attempt + 1)}
          className="flex items-center gap-1.5 rounded-full border border-red-400/30 bg-red-500/10 px-3 py-1.5 text-sm text-red-200 transition hover:bg-red-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300/60"
        >
          <AlertCircle className="h-3.5 w-3.5" />
          Could not load boards — Retry
        </button>
      ) : !boardsLoading && boards.length === 0 ? (
        <button type="button" disabled={creating || !projectId} onClick={createBoard} className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-ink-900 disabled:opacity-50">{creating ? "Creating…" : "Create board"}</button>
      ) : renamingTrigger ? (
        <input
          autoFocus
          defaultValue={current?.name ?? "Choose board"}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => {
            if (boardId) renameBoard(boardId, e.currentTarget.value);
            setRenamingTrigger(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setRenamingTrigger(false);
          }}
          className="rounded-full border border-brand/40 bg-ink-700 px-3 py-1.5 text-sm text-white outline-none"
        />
      ) : (
        <Dropdown
          trigger={(open) => (
            <span
              className={cn(
                "flex max-w-[220px] items-center gap-1.5 rounded-full border border-line bg-ink-700 pl-3 pr-2 py-1.5 text-sm text-white/85 transition hover:text-white",
                open && "border-brand/40"
              )}
            >
              <span className="truncate">
                {boardsLoading ? "Loading boards…" : current?.name ?? "Choose board"}
              </span>
              <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-180")} />
            </span>
          )}
        >
          {(close) => (
            <div className="w-56">
              {boards.map((b) =>
                renamingRowId === b.id ? (
                  <input
                    key={b.id}
                    autoFocus
                    defaultValue={b.name}
                    onFocus={(e) => e.currentTarget.select()}
                    onBlur={(e) => {
                      renameBoard(b.id, e.currentTarget.value);
                      setRenamingRowId(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") setRenamingRowId(null);
                    }}
                    className="mb-0.5 w-full rounded-lg border border-brand/40 bg-ink-800 px-2.5 py-2 text-sm text-white outline-none"
                  />
                ) : (
                  <div key={b.id} className="group flex items-center">
                    <MenuItem
                      active={b.id === boardId}
                      onClick={() => {
                        onBoardIdChange(b.id);
                        close();
                      }}
                    >
                      <span className="flex-1 truncate">{b.name}</span>
                      {b.id === boardId && <Check className="h-4 w-4 shrink-0 text-brand" />}
                    </MenuItem>
                    <Dropdown
                      align="right"
                      trigger={(open) => (
                        <span
                          className={cn(
                            "ml-0.5 hidden h-7 w-7 shrink-0 place-items-center rounded-lg text-white/45 hover:bg-white/10 hover:text-white group-hover:grid",
                            open && "grid bg-white/10 text-white"
                          )}
                        >
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </span>
                      )}
                    >
                      {(closeRow) => (
                        <>
                          <MenuItem
                            onClick={() => {
                              setRenamingRowId(b.id);
                              closeRow();
                            }}
                          >
                            <Pencil className="h-4 w-4 text-white/50" /> Rename
                          </MenuItem>
                          <MenuItem
                            onClick={() => {
                              setDeleteTarget(b);
                              closeRow();
                              close();
                            }}
                          >
                            <Trash2 className="h-4 w-4 text-red-400/80" />
                            <span className="text-red-300/90">Delete</span>
                          </MenuItem>
                        </>
                      )}
                    </Dropdown>
                  </div>
                )
              )}
              <div className="my-1 h-px bg-line" />
              <MenuItem
                onClick={() => {
                  createBoard();
                  close();
                }}
              >
                <Plus className="h-4 w-4 text-white/60" /> New board
              </MenuItem>
            </div>
          )}
        </Dropdown>
      )}

      {deleteTarget &&
        typeof document !== "undefined" &&
        createPortal(
          <DeleteBoardDialog
            board={deleteTarget}
            onCancel={() => setDeleteTarget(null)}
            onConfirm={() => {
              deleteBoard(deleteTarget.id);
              setDeleteTarget(null);
            }}
          />,
          document.body
        )}
    </>
  );
}

function DeleteBoardDialog({
  board,
  onCancel,
  onConfirm,
}

) {
  const cancelRef = useRef(null);

  useEffect(() => {
    // Double rAF: the row menu this dialog opens from schedules its own
    // focus-restore-to-trigger on close via a single rAF (Dropdown.tsx's
    // closeAndRestore) — a same-frame focus() here can lose that race and
    // get silently overridden a tick later. Deferring two frames guarantees
    // we focus Cancel *after* that restore, not before it.
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => cancelRef.current?.focus());
    });
    const onKeyDown = (e) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-[200] grid place-items-center bg-black/50" onClick={onCancel}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-board-title"
        onClick={(e) => e.stopPropagation()}
        className="w-[22rem] rounded-2xl border border-line bg-ink-750 p-5 shadow-pop"
      >
        <h2 id="delete-board-title" className="text-sm font-semibold text-white">
          Delete this board?
        </h2>
        <p className="mt-2 text-sm text-white/60">
          “{board.name}” will be deleted. This cannot be undone.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-white/70 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-brand"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-lg bg-red-500/80 px-3 py-1.5 text-sm font-semibold text-white outline-none hover:bg-red-500 focus-visible:ring-2 focus-visible:ring-brand"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
