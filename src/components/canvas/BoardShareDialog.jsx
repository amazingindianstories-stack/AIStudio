"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { Crown, Loader2, Users, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  BOARD_ROLE_OPTIONS,
  PROJECT_ROLE_OPTIONS,
  ROLE_LABELS,
  changeBoardAccess,
  changeProjectMembers,
  fetchBoardAccess,
  fetchTeammates,
} from "@/lib/board-access";

const selectClass =
  "rounded-lg border border-line bg-ink-700 px-2 py-1.5 text-xs text-white outline-none transition focus:border-white/25 focus:ring-2 focus:ring-white/10 disabled:cursor-not-allowed disabled:opacity-55";

/**
 * Who has access to a board (Miro's Share dialog): the owner, the access every
 * teammate gets, individual board members and the project's roles, which
 * apply to every board in the project. The highest role a person has wins.
 * `onAccessChange` receives the refreshed access so the canvas can follow a
 * change to the caller's own role (for example after transferring ownership).
 */
export function BoardShareDialog({ boardId, boardName, projectName, onClose, onAccessChange }) {
  const titleId = useId();
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const [access, setAccess] = useState(null);
  const [teammates, setTeammates] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmOwner, setConfirmOwner] = useState(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchBoardAccess(boardId), fetchTeammates()])
      .then(([nextAccess, users]) => {
        if (cancelled) return;
        setAccess(nextAccess);
        setTeammates(users);
      })
      .catch((err) => !cancelled && setError(err.message || "Could not load sharing."));
    return () => {
      cancelled = true;
    };
  }, [boardId]);

  useEffect(() => {
    const previousFocus = document.activeElement;
    const frame = requestAnimationFrame(() => closeRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      previousFocus?.focus?.();
    };
  }, []);

  const closeConfirm = useCallback(() => {
    flushSync(() => setConfirmOwner(null));
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        if (confirmOwner) closeConfirm();
        else onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll("button:not(:disabled), select:not(:disabled)") ?? []
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [closeConfirm, confirmOwner, onClose]);

  const people = useMemo(() => new Map(teammates.map((user) => [user.id, user])), [teammates]);

  const run = useCallback(
    async (action) => {
      const focused = document.activeElement;
      setBusy(true);
      setError("");
      try {
        await action();
        const next = await fetchBoardAccess(boardId);
        setAccess(next);
        onAccessChange?.(next);
      } catch (err) {
        setError(err.message || "Could not update sharing.");
      } finally {
        flushSync(() => setBusy(false));
        if (document.activeElement === document.body) (focused?.isConnected ? focused : closeRef.current)?.focus();
      }
    },
    [boardId, onAccessChange]
  );

  const boardChange = (change) => run(() => changeBoardAccess(boardId, change));
  const projectChange = (change) => run(() => changeProjectMembers(access.projectId, change));

  const memberIds = new Set((access?.members ?? []).map((member) => member.userId));
  const projectMemberIds = new Set((access?.projectMembers ?? []).map((member) => member.userId));
  const activeTeammates = teammates.filter((user) => user.isActive);
  const boardCandidates = activeTeammates.filter((user) => user.id !== access?.ownerId && !memberIds.has(user.id));
  const projectCandidates = activeTeammates.filter((user) => !projectMemberIds.has(user.id));

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] grid place-items-center bg-black/55 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex max-h-[85dvh] w-full max-w-[30rem] flex-col overflow-hidden rounded-2xl border border-line bg-ink-750 shadow-pop"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-sm font-semibold text-white">Share board</h2>
            <p className="mt-0.5 truncate text-xs text-white/50">{boardName}</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-white/55 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-brand"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {!access ? (
            <div className="grid place-items-center py-10 text-white/50">
              {error ? <p role="alert" className="text-sm text-red-300">{error}</p> : <Loader2 className="h-5 w-5 animate-spin" />}
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              <section aria-label="Everyone in the studio">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/10 text-white/70">
                      <Users className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm text-white/85">Everyone in the studio</p>
                      <p className="text-xs text-white/45">Applies to all signed-in teammates</p>
                    </div>
                  </div>
                  <select
                    aria-label="Team access"
                    className={selectClass}
                    value={access.teamRole}
                    disabled={!access.canOwn || busy}
                    onChange={(event) => boardChange({ op: "setTeamRole", role: event.target.value })}
                  >
                    {BOARD_ROLE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
              </section>

              <section aria-label="Board members">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/40">On this board</h3>
                {access.canShare && (
                  <AddPersonRow
                    label="Add a teammate to this board"
                    candidates={boardCandidates}
                    roles={BOARD_ROLE_OPTIONS}
                    defaultRole="edit"
                    busy={busy}
                    onAdd={(userId, role) => boardChange({ op: "setMember", userId, role })}
                  />
                )}
                <ul className="mt-2 flex flex-col gap-1">
                  {access.ownerId && (
                    <PersonRow person={people.get(access.ownerId)} fallbackId={access.ownerId}>
                      <span className="flex items-center gap-1 px-2 text-xs text-amber-200/90">
                        <Crown className="h-3.5 w-3.5" /> Owner
                      </span>
                    </PersonRow>
                  )}
                  {access.members.map((member) => (
                    <PersonRow key={member.userId} person={people.get(member.userId)} fallbackId={member.userId}>
                      {access.canShare ? (
                        <>
                          <select
                            aria-label={`Board role for ${displayName(people.get(member.userId), member.userId)}`}
                            className={selectClass}
                            value={member.role}
                            disabled={busy}
                            onChange={(event) => boardChange({ op: "setMember", userId: member.userId, role: event.target.value })}
                          >
                            {BOARD_ROLE_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                          {access.canOwn && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setConfirmOwner(member.userId)}
                              className="rounded-lg px-2 py-1 text-xs text-white/55 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50"
                            >
                              Make owner
                            </button>
                          )}
                          <button
                            type="button"
                            aria-label={`Remove ${displayName(people.get(member.userId), member.userId)} from this board`}
                            disabled={busy}
                            onClick={() => boardChange({ op: "removeMember", userId: member.userId })}
                            className="grid h-7 w-7 place-items-center rounded-lg text-white/45 outline-none hover:bg-white/10 hover:text-red-300 focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </>
                      ) : (
                        <span className="px-2 text-xs text-white/55">{ROLE_LABELS[member.role]}</span>
                      )}
                    </PersonRow>
                  ))}
                </ul>
              </section>

              <section aria-label="Project roles">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-white/40">Project roles</h3>
                <p className="mb-2 mt-0.5 text-xs text-white/45">
                  Apply to every board in {projectName || "this project"}.
                </p>
                {access.canManageProject && (
                  <AddPersonRow
                    label="Add a teammate to this project"
                    candidates={projectCandidates}
                    roles={access.projectRole === "owner" ? PROJECT_ROLE_OPTIONS : PROJECT_ROLE_OPTIONS.filter((option) => option.value !== "owner")}
                    defaultRole="editor"
                    busy={busy}
                    onAdd={(userId, role) => projectChange({ op: "setMember", userId, role })}
                  />
                )}
                {access.projectMembers.length === 0 ? (
                  <p className="mt-2 text-xs text-white/40">No project roles yet.</p>
                ) : (
                  <ul className="mt-2 flex flex-col gap-1">
                    {access.projectMembers.map((member) => {
                      const editable = access.canManageProject && (access.projectRole === "owner" || member.role !== "owner");
                      const name = displayName(people.get(member.userId), member.userId);
                      return (
                        <PersonRow key={member.userId} person={people.get(member.userId)} fallbackId={member.userId}>
                          {editable ? (
                            <>
                              <select
                                aria-label={`Project role for ${name}`}
                                className={selectClass}
                                value={member.role}
                                disabled={busy}
                                onChange={(event) => projectChange({ op: "setMember", userId: member.userId, role: event.target.value })}
                              >
                                {(access.projectRole === "owner" ? PROJECT_ROLE_OPTIONS : PROJECT_ROLE_OPTIONS.filter((option) => option.value !== "owner")).map((option) => (
                                  <option key={option.value} value={option.value}>{option.label}</option>
                                ))}
                              </select>
                              <button
                                type="button"
                                aria-label={`Remove ${name} from this project`}
                                disabled={busy}
                                onClick={() => projectChange({ op: "removeMember", userId: member.userId })}
                                className="grid h-7 w-7 place-items-center rounded-lg text-white/45 outline-none hover:bg-white/10 hover:text-red-300 focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50"
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </>
                          ) : (
                            <span className="px-2 text-xs text-white/55">
                              {PROJECT_ROLE_OPTIONS.find((option) => option.value === member.role)?.label}
                            </span>
                          )}
                        </PersonRow>
                      );
                    })}
                  </ul>
                )}
              </section>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
          <p className="text-xs text-white/45">
            {access ? <>Your access: <span className="text-white/75">{ROLE_LABELS[access.role]}</span>. The highest role wins.</> : " "}
          </p>
          {access && error && <p role="alert" className="text-xs text-red-300">{error}</p>}
          {busy && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-white/50" />}
        </div>

        {confirmOwner && (
          <div className="absolute inset-0 grid place-items-center bg-black/40 p-4">
            <div role="alertdialog" aria-modal="true" aria-label="Transfer ownership" className="w-full max-w-[22rem] rounded-2xl border border-line bg-ink-750 p-5 shadow-pop">
              <h3 className="text-sm font-semibold text-white">Make {displayName(people.get(confirmOwner), confirmOwner)} the owner?</h3>
              <p className="mt-2 text-sm text-white/60">
                They get full control of this board, including deleting it. You stay on the board with edit access.
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  autoFocus
                  onClick={closeConfirm}
                  className="rounded-lg px-3 py-1.5 text-sm font-medium text-white/70 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-brand"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const userId = confirmOwner;
                    setConfirmOwner(null);
                    boardChange({ op: "transferOwner", userId });
                  }}
                  className="rounded-lg bg-brand/90 px-3 py-1.5 text-sm font-semibold text-ink-900 outline-none hover:bg-brand focus-visible:ring-2 focus-visible:ring-white/60"
                >
                  Transfer ownership
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

function displayName(person, fallbackId) {
  return person?.name || person?.email || `User ${String(fallbackId).slice(0, 8)}`;
}

function PersonRow({ person, fallbackId, children }) {
  const name = displayName(person, fallbackId);
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg px-1 py-1">
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          className="relative grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-full text-xs font-semibold text-ink-900"
          style={{ background: person?.color || "#34d399" }}
        >
          {name.charAt(0).toUpperCase()}
          {person?.avatarUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={person.avatarUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
          )}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm text-white/85">{name}</p>
          {person?.email && person.email !== name && <p className="truncate text-xs text-white/45">{person.email}</p>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">{children}</div>
    </li>
  );
}

function AddPersonRow({ label, candidates, roles, defaultRole, busy, onAdd }) {
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState(defaultRole);
  const disabled = busy || candidates.length === 0;
  return (
    <div className="flex items-center gap-2">
      <select
        aria-label={label}
        className={cn(selectClass, "min-w-0 flex-1")}
        value={userId}
        disabled={disabled}
        onChange={(event) => setUserId(event.target.value)}
      >
        <option value="">{candidates.length ? "Add a teammate…" : "Everyone is already added"}</option>
        {candidates.map((user) => (
          <option key={user.id} value={user.id}>{displayName(user, user.id)}</option>
        ))}
      </select>
      <select aria-label="Role" className={selectClass} value={role} disabled={disabled} onChange={(event) => setRole(event.target.value)}>
        {roles.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <button
        type="button"
        disabled={disabled || !userId}
        onClick={() => {
          onAdd(userId, role);
          setUserId("");
        }}
        className="rounded-lg bg-brand/20 px-3 py-1.5 text-xs font-semibold text-brand outline-none hover:bg-brand/30 focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-45"
      >
        Add
      </button>
    </div>
  );
}
