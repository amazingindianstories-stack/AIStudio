"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Plus, Pencil, Trash2, Check, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { Dropdown, MenuItem } from "@/components/Dropdown";
import type { CanvasBoardMeta } from "@/lib/canvas/types";

/**
 * Top-left floating board dropdown (ui-spec §8): list/create/rename/switch,
 * delete gated behind a styled confirm dialog (never a native `confirm()`).
 * Owns the board-metadata list for the active project — `canvas-store.ts`
 * only holds the *content* of whichever single board is loaded.
 */
export function BoardSwitcher({
  projectId,
  boardId,
  onBoardIdChange,
  leftOffset,
}: {
  projectId: string | null;
  boardId: string | null;
  onBoardIdChange: (id: string) => void;
  /** Left edge in px, offset past the asset panel so the two never overlap. */
  leftOffset: number;
}) {
  const [boards, setBoards] = useState<CanvasBoardMeta[]>([]);
  const [renamingTrigger, setRenamingTrigger] = useState(false);
  const [renamingRowId, setRenamingRowId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CanvasBoardMeta | null>(null);
  const initializedForProject = useRef<string | null>(null);

  useEffect(() => {
    if (!projectId || initializedForProject.current === projectId) return;
    initializedForProject.current = projectId;
    (async () => {
      const res = await fetch(`/api/canvas-boards?projectId=${encodeURIComponent(projectId)}`, {
        cache: "no-store",
      });
      const json = await res.json().catch(() => ({}));
      let list: CanvasBoardMeta[] = json.boards ?? [];
      if (list.length === 0) {
        const created = await fetch("/api/canvas-boards", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ op: "createBoard", projectId, name: "Untitled board" }),
        });
        const createdJson = await created.json().catch(() => ({}));
        list = createdJson.boards ?? [];
      }
      setBoards(list);
      if (!boardId || !list.some((b) => b.id === boardId)) {
        if (list[0]) onBoardIdChange(list[0].id);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const current = boards.find((b) => b.id === boardId) ?? null;

  const createBoard = async () => {
    if (!projectId) return;
    const res = await fetch("/api/canvas-boards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "createBoard", projectId, name: "Untitled board" }),
    });
    const json = await res.json().catch(() => ({}));
    if (json.boards) {
      setBoards(json.boards);
      if (json.board?.id) {
        onBoardIdChange(json.board.id);
        setRenamingTrigger(true);
      }
    }
  };

  const renameBoard = async (id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBoards((bs) => bs.map((b) => (b.id === id ? { ...b, name: trimmed } : b)));
    const res = await fetch("/api/canvas-boards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "renameBoard", id, name: trimmed }),
    });
    const json = await res.json().catch(() => ({}));
    if (json.boards) setBoards(json.boards);
  };

  const deleteBoard = async (id: string) => {
    const res = await fetch("/api/canvas-boards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "deleteBoard", id }),
    });
    const json = await res.json().catch(() => ({}));
    const list: CanvasBoardMeta[] = json.boards ?? boards.filter((b) => b.id !== id);
    setBoards(list);
    if (boardId === id) {
      if (list[0]) {
        onBoardIdChange(list[0].id);
      } else if (projectId) {
        // last board deleted — auto-create a fresh one so a board is always open
        const created = await fetch("/api/canvas-boards", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ op: "createBoard", projectId, name: "Untitled board" }),
        });
        const createdJson = await created.json().catch(() => ({}));
        setBoards(createdJson.boards ?? []);
        if (createdJson.board?.id) onBoardIdChange(createdJson.board.id);
      }
    }
  };

  return (
    <div className="absolute top-4 z-30 transition-[left] duration-200" style={{ left: leftOffset }}>
      {renamingTrigger ? (
        <input
          autoFocus
          defaultValue={current?.name ?? "Untitled board"}
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
              <span className="truncate">{current?.name ?? "Untitled board"}</span>
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
    </div>
  );
}

function DeleteBoardDialog({
  board,
  onCancel,
  onConfirm,
}: {
  board: CanvasBoardMeta;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

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
    const onKeyDown = (e: KeyboardEvent) => {
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
          “{board.name}” will be deleted. This can't be undone.
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
