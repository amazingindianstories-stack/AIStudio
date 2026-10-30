"use client";

import { useMemo, useState } from "react";
import { useCanvasStore } from "@/lib/canvas-store";
import { useBoardUi } from "@/lib/canvas/board-ui";
import { boardSummary, describeObject } from "@/lib/canvas/a11y-check";
import { readingOrder } from "@/lib/canvas/keyboard-nav";
import { orderedFrames } from "@/lib/canvas/frames";
import { BoardPanel } from "./BoardPanel";

const LIST_LIMIT = 300;

const ROW =
  "block w-full truncate rounded-lg px-2.5 py-1.5 text-left text-sm text-white/80 outline-none hover:bg-white/[0.06] hover:text-white focus-visible:ring-2 focus-visible:ring-brand";

/** Shows and selects `id` on the board and says what it is. */
export function jumpToObject(id) {
  const store = useCanvasStore.getState();
  if (!store.focusObject(id)) return;
  const node = store.history.present.nodes.find((n) => n.id === id);
  if (node) useBoardUi.getState().announce(describeObject(node, store.history.present));
}

/**
 * "Explore board content": the board as a list a screen reader can browse,
 * frames first in presentation order with what each holds, then the
 * objects outside frames, all in reading order. Built from the board data,
 * so it lists everything, on screen or not.
 */
export function BoardOutline({ onClose }) {
  const present = useCanvasStore((s) => s.history.present);
  const [showAll, setShowAll] = useState(false);

  const { frames, loose } = useMemo(() => {
    const byId = new Map(present.nodes.map((n) => [n.id, n]));
    const childrenOf = new Map();
    for (const node of present.nodes) {
      if (node.parentId && byId.get(node.parentId)?.type === "frame") {
        if (!childrenOf.has(node.parentId)) childrenOf.set(node.parentId, []);
        childrenOf.get(node.parentId).push(node);
      }
    }
    const looseNodes = present.nodes.filter((n) => n.type !== "frame" && !(n.parentId && byId.get(n.parentId)?.type === "frame"));
    return {
      frames: orderedFrames(present).map((frame) => ({ frame, children: readingOrder(childrenOf.get(frame.id) ?? []).map((id) => byId.get(id)) })),
      loose: readingOrder(looseNodes).map((id) => byId.get(id)),
    };
  }, [present]);

  const limited = (list) => (showAll ? list : list.slice(0, LIST_LIMIT));
  const total = present.nodes.length;

  return (
    <BoardPanel label="Explore board content" title="Explore board content" subtitle={boardSummary(present)} onClose={onClose}>
      {!total ? (
        <p className="px-3 py-6 text-center text-sm text-white/50">Nothing on this board yet.</p>
      ) : (
        <nav aria-label="Board content">
          {frames.length > 0 && (
            <>
              <h3 className="px-2.5 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-white/40">Frames</h3>
              <ul>
                {limited(frames).map(({ frame, children }) => (
                  <li key={frame.id}>
                    <button type="button" onClick={() => jumpToObject(frame.id)} className={ROW}>
                      {describeObject(frame, present)}
                    </button>
                    {children.length > 0 && (
                      <ul aria-label={`In ${frame.name?.trim() || "untitled frame"}`} className="ml-3 border-l border-line pl-1">
                        {limited(children).map((node) => (
                          <li key={node.id}>
                            <button type="button" onClick={() => jumpToObject(node.id)} className={ROW}>
                              {describeObject(node, present)}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {loose.length > 0 && (
            <>
              <h3 className="px-2.5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-white/40">
                {frames.length ? "Outside frames" : "Objects"}
              </h3>
              <ul>
                {limited(loose).map((node) => (
                  <li key={node.id}>
                    <button type="button" onClick={() => jumpToObject(node.id)} className={ROW}>
                      {describeObject(node, present)}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {!showAll && total > LIST_LIMIT && (
            <button type="button" onClick={() => setShowAll(true)} className="mt-2 w-full rounded-lg py-1.5 text-xs font-semibold text-white/70 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-brand">
              Show everything ({total} objects)
            </button>
          )}
        </nav>
      )}
    </BoardPanel>
  );
}
