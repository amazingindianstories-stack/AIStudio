"use client";

import { useEffect, useState } from "react";
import { useCanvasStore } from "@/lib/canvas-store";
import { displayName } from "@/lib/board-access";
import { formatWhen } from "@/lib/canvas/board-activity";
import { usePeople } from "@/lib/canvas/use-people";

function selectedObject(state) {
  const { selection, selectedConnectorIds, history } = state;
  if (selection.length + selectedConnectorIds.length !== 1) return null;
  const id = selection[0] ?? selectedConnectorIds[0];
  return history.present.nodes.find((node) => node.id === id) ?? history.present.connectors.find((item) => item.id === id) ?? null;
}

/** Re-renders every half minute, so "5 min ago" stays true. */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * Who created the one selected object and who last changed it, and when, from
 * the stamps the server writes on save. Objects from before stamping have none
 * and show nothing; an object only edited since shows its last change.
 */
export function ObjectInfo({ style }) {
  const object = useCanvasStore(selectedObject);
  const people = usePeople();
  const now = useNow();
  if (!object) return null;
  const created = typeof object.createdBy === "string" && typeof object.createdAt === "number";
  const updated = typeof object.updatedBy === "string" && typeof object.updatedAt === "number";
  if (!created && !updated) return null;
  const name = (id) => displayName(people.get(id), id);
  const changedSinceCreated = updated && (!created || object.updatedAt !== object.createdAt || object.updatedBy !== object.createdBy);
  return (
    <p
      aria-label="Object info"
      style={style}
      className="pointer-events-none absolute bottom-[4.75rem] z-30 flex max-w-[min(32rem,calc(100%-2rem))] flex-wrap items-center gap-x-2 gap-y-0.5 rounded-full border border-line bg-ink-750/95 px-3 py-1.5 text-xs text-white/55 shadow-pop backdrop-blur-xl"
    >
      {created && (
        <span>
          Created by <span className="text-white/85">{name(object.createdBy)}</span> · {formatWhen(object.createdAt, now)}
        </span>
      )}
      {created && changedSinceCreated && <span aria-hidden className="text-white/25">|</span>}
      {changedSinceCreated && (
        <span>
          Last changed by <span className="text-white/85">{name(object.updatedBy)}</span> · {formatWhen(object.updatedAt, now)}
        </span>
      )}
    </p>
  );
}
