"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

const TONES = {
  info: "bg-ink-800 text-white/80",
  important: "bg-amber-500/15 text-amber-100",
  critical: "bg-red-500/20 text-red-100",
};

const RANK = { critical: 0, important: 1, info: 2 };

// Shared workspace identity and announcements from GET /api/workspace.
export function useWorkspace() {
  const user = useStore((s) => s.currentUser);
  const [workspace, setWorkspace] = useState(null);
  useEffect(() => {
    if (!user) return undefined;
    let live = true;
    apiFetch("/api/workspace")
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => live && json && setWorkspace(json))
      .catch(() => {});
    return () => { live = false; };
  }, [user]);
  return workspace;
}

export function WorkspaceBanner() {
  const workspace = useWorkspace();
  const [dismissed, setDismissed] = useState([]);
  const list = (workspace?.announcements || [])
    .filter((a) => !dismissed.includes(a.id))
    .sort((a, b) => (RANK[a.priority] ?? 3) - (RANK[b.priority] ?? 3));
  const top = list[0];
  if (!top) return null;
  return (
    <div
      role={top.priority === "critical" ? "alert" : "status"}
      data-testid="workspace-announcement"
      className={cn("flex items-center gap-3 border-b border-line px-4 py-2 text-sm", TONES[top.priority] || TONES.info)}
    >
      <span className="font-semibold">{top.title}</span>
      {top.body ? <span className="min-w-0 flex-1 truncate">{top.body}</span> : <span className="flex-1" />}
      {top.ctaUrl ? (
        <a href={top.ctaUrl} target="_blank" rel="noreferrer" className="shrink-0 underline">
          {top.ctaLabel || "Learn more"}
        </a>
      ) : null}
      <button type="button" aria-label="Dismiss announcement" className="shrink-0 px-1" onClick={() => setDismissed((d) => [...d, top.id])}>
        x
      </button>
    </div>
  );
}
