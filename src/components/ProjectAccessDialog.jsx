"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMaintenance } from "@/lib/maintenance-client";
import { fetchTeammates } from "@/lib/board-access";
import { PROJECT_ACCESS_OPTIONS, settleProjectAccess, useProjectAccessRequest } from "@/lib/project-access";

/** Create / settings dialog for a project's visibility: Everyone, Particular users (with a picker) or Admin only. */
export function ProjectAccessDialog() {
  const maintenance = useMaintenance((s) => s.enabled);
  const request = useProjectAccessRequest((state) => state.request);
  const [name, setName] = useState("");
  const [access, setAccess] = useState("all");
  const [picked, setPicked] = useState([]);
  const [users, setUsers] = useState(null);
  const [filter, setFilter] = useState("");
  const titleId = useId();
  const firstRef = useRef(null);

  useEffect(() => {
    useProjectAccessRequest.setState({ hostMounted: true });
    return () => {
      settleProjectAccess(null);
      useProjectAccessRequest.setState({ hostMounted: false });
    };
  }, []);

  useEffect(() => {
    if (!request) return undefined;
    setName(request.name || "");
    setAccess(request.access || "all");
    setPicked(request.accessUserIds || []);
    setFilter("");
    const previousFocus = document.activeElement;
    const frame = requestAnimationFrame(() => firstRef.current?.focus());
    const onKeyDown = (event) => { if (event.key === "Escape") settleProjectAccess(null); };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus?.();
    };
  }, [request]);

  useEffect(() => {
    if (!request || access !== "users" || users) return;
    let live = true;
    fetchTeammates().then((list) => { if (live) setUsers(list); }).catch(() => { if (live) setUsers([]); });
    return () => { live = false; };
  }, [request, access, users]);

  if (!request || typeof document === "undefined") return null;
  const trimmed = name.trim();
  const canSubmit = !maintenance && (!request.askName || trimmed.length > 0) && (access !== "users" || picked.length > 0);
  const visible = (users ?? []).filter((user) => `${user.name} ${user.email}`.toLowerCase().includes(filter.trim().toLowerCase()));
  const toggle = (id) => setPicked((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]));

  return createPortal(
    <div className="fixed inset-0 z-[220] grid place-items-center bg-black/65 p-4 backdrop-blur-sm"
      onMouseDown={(event) => { if (event.target === event.currentTarget) settleProjectAccess(null); }}>
      <form role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="w-full max-w-sm rounded-2xl border border-line bg-ink-750 p-5 shadow-pop"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) settleProjectAccess({ ...(request.askName ? { name: trimmed } : {}), access, accessUserIds: access === "users" ? picked : [] });
        }}>
        <h2 id={titleId} className="text-base font-semibold text-white">{request.title}</h2>
        {request.askName && (
          <label className="mt-3 block text-xs text-white/60">
            <span className="mb-1 block">Project name</span>
            <input ref={firstRef} value={name} onChange={(event) => setName(event.target.value)} maxLength={200} aria-label="Project name"
              className="w-full rounded-lg border border-line bg-ink-900 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand" />
          </label>
        )}
        <fieldset className="mt-3">
          <legend className="mb-1 text-xs text-white/60">Who can see this project</legend>
          <div className="space-y-1">
            {PROJECT_ACCESS_OPTIONS.map((option, index) => (
              <label key={option.value} className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm ${access === option.value ? "border-brand/60 bg-brand/10" : "border-line hover:bg-white/5"}`}>
                <input ref={!request.askName && index === 0 ? firstRef : undefined} type="radio" name="project-access" value={option.value}
                  checked={access === option.value} onChange={() => setAccess(option.value)} className="mt-1 accent-brand" />
                <span className="min-w-0">
                  <span className="block font-medium text-white">{option.label}</span>
                  <span className="block text-xs text-white/50">{option.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {access === "users" && (
          <div className="mt-3">
            <input value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Search users" placeholder="Search users…"
              className="w-full rounded-lg border border-line bg-ink-900 px-3 py-1.5 text-xs text-white placeholder-white/30 focus:border-brand focus:outline-none" />
            <ul aria-label="Users with access" className="mt-1 max-h-40 overflow-y-auto scroll-thin rounded-lg border border-line">
              {users === null && <li className="px-3 py-2 text-xs text-white/50">Loading users…</li>}
              {users !== null && visible.length === 0 && <li className="px-3 py-2 text-xs text-white/50">No users found</li>}
              {visible.map((user) => (
                <li key={user.id}>
                  <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs text-white/85 hover:bg-white/5">
                    <input type="checkbox" checked={picked.includes(user.id)} onChange={() => toggle(user.id)} className="accent-brand" />
                    <span className="min-w-0 flex-1 truncate">{user.name}</span>
                    <span className="truncate text-white/40">{user.email}</span>
                  </label>
                </li>
              ))}
            </ul>
            {picked.length === 0 && <p className="mt-1 text-xs text-amber-300/80">Pick at least one user.</p>}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={() => settleProjectAccess(null)} className="rounded-lg px-3 py-1.5 text-sm text-white/70 hover:bg-white/10 hover:text-white">Cancel</button>
          <button type="submit" disabled={!canSubmit} className="rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-black disabled:opacity-40">{request.confirmLabel}</button>
        </div>
      </form>
    </div>,
    document.body
  );
}
