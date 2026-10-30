"use client";

import { useEffect, useState } from "react";
import { Link2 } from "lucide-react";
import { Dropdown } from "@/components/Dropdown";
import { apiFetch } from "@/lib/api";
import { listFrames } from "@/lib/synced-frames";
import { addSyncedCopy } from "@/lib/synced-actions";

/** Toolbar entry that inserts a view-only copy of a frame from a board of the same project. */
export function SyncedMenu({ projectId, boardId }) {
  return (
    <Dropdown
      side="top"
      label="Synced copy"
      panelClassName="min-w-0"
      trigger={(open) => (
        <span
          title="Insert a synced copy of a frame"
          className={"grid h-9 w-9 place-items-center rounded-lg text-white/55 transition-colors hover:bg-white/[0.07] hover:text-white max-sm:h-8 max-sm:w-8 " + (open ? "bg-white/[0.07]" : "")}
        >
          <Link2 className="h-4 w-4" />
        </span>
      )}
    >
      {(close) => <SyncedPicker projectId={projectId} boardId={boardId} close={close} />}
    </Dropdown>
  );
}

function SyncedPicker({ projectId, boardId, close }) {
  const [boards, setBoards] = useState(null);
  const [picked, setPicked] = useState("");
  const [frames, setFrames] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await apiFetch(`/api/canvas-boards?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
        const json = res.ok ? await res.json() : { boards: [] };
        if (alive) setBoards((json.boards ?? []).filter((b) => b.id !== boardId));
      } catch {
        if (alive) setBoards([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectId, boardId]);

  const choose = async (id) => {
    setPicked(id);
    setFrames(null);
    if (!id) return;
    const result = await listFrames(id);
    setFrames(result?.frames ?? []);
  };

  return (
    <div className="w-[260px] space-y-2 p-1 text-xs text-white/80" onPointerDown={(e) => e.stopPropagation()}>
      <p className="px-0.5 text-[11px] font-medium uppercase tracking-wide text-white/40">Synced copy</p>
      <p className="text-[11px] text-white/50">Shows a frame from another board. It is view-only and refreshes on its own; edit it on the original board.</p>
      <select aria-label="Source board" value={picked} onChange={(e) => choose(e.target.value)} className="w-full rounded bg-ink-700 px-1.5 py-1 text-white outline-none ring-1 ring-line focus:ring-brand">
        <option value="">{boards === null ? "Loading boards" : "Choose a board"}</option>
        {(boards ?? []).map((b) => (
          <option key={b.id} value={b.id}>{b.name}</option>
        ))}
      </select>
      {picked && frames === null && <p className="text-white/50">Loading frames</p>}
      {frames && frames.length === 0 && <p className="text-white/50">That board has no frames you can copy.</p>}
      {frames?.map((f) => (
        <button
          key={f.id}
          type="button"
          className="block w-full truncate rounded-md px-2 py-1.5 text-left hover:bg-white/10"
          onClick={() => {
            addSyncedCopy(picked, f);
            close({ restoreFocus: false });
          }}
        >
          {f.name}
        </button>
      ))}
    </div>
  );
}
