"use client";

import { Minus, Plus } from "lucide-react";
import { useFacilitationStore } from "@/lib/canvas/facilitation-store";
import { canAddVote, canRemoveVote, votable } from "@/lib/canvas/facilitation";
import { canCommentRole } from "@/lib/board-access";
import { useCanvasStore } from "@/lib/canvas-store";

/**
 * Votes on one object. While a session runs, an object it covers shows a vote control with this person's own
 * count (everyone else's stay secret until the session ends); the totals of a session the board shows appear
 * as a badge. Reads the store, not the DOM, so it works on whatever the board draws.
 */
export function VoteBadge({ node }) {
  const active = useFacilitationStore((s) => s.voting.active);
  const shown = useFacilitationStore((s) => s.voting.shown);
  const role = useCanvasStore((s) => s.boardRole);
  const total = shown?.totals?.[node.id];
  const voting = active && canCommentRole(role) && votable(active, node);
  if (!voting && !total) return null;
  const mine = active?.myVotes?.[node.id] ?? 0;
  const cast = (delta) => {
    void useFacilitationStore.getState().adjustVote(active.id, node.id, delta).catch(() => {});
  };
  return (
    <div
      data-vote-badge={node.id}
      className="pointer-events-auto absolute -right-3 -top-3 z-30 flex items-center gap-0.5 rounded-full border border-line bg-ink-800 px-1 py-0.5 text-xs font-semibold text-white shadow-pop"
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {voting ? (
        <>
          <button
            type="button"
            aria-label="Remove a vote"
            disabled={!canRemoveVote(active, node.id)}
            onClick={() => cast(-1)}
            className="grid h-5 w-5 place-items-center rounded-full hover:bg-white/10 disabled:opacity-30"
          >
            <Minus className="h-3 w-3" />
          </button>
          <span data-vote-count className="min-w-4 text-center tabular-nums">{mine}</span>
          <button
            type="button"
            aria-label="Add a vote"
            disabled={!canAddVote(active, node.id)}
            onClick={() => cast(1)}
            className="grid h-5 w-5 place-items-center rounded-full bg-brand text-ink-900 hover:bg-brand/90 disabled:opacity-30"
          >
            <Plus className="h-3 w-3" />
          </button>
        </>
      ) : (
        <span data-vote-total className="px-1.5 tabular-nums">{total} {total === 1 ? "vote" : "votes"}</span>
      )}
    </div>
  );
}
