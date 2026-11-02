"use client";

import { displayName } from "@/lib/board-access";
import { useCommentsStore } from "@/lib/canvas/comments-store";
import { Avatar } from "./Avatar";

const MAX_SHOWN = 4;

/** Who has this board open right now: seen on the board within the last 30 seconds, from the poll. */
export function PeopleBar({ people, currentUserId }) {
  const present = useCommentsStore((s) => s.people);
  const others = present.filter((entry) => entry.userId !== String(currentUserId));
  if (others.length === 0) return null;
  const shown = others.slice(0, MAX_SHOWN);
  const names = others.map((entry) => displayName(people.get(entry.userId), entry.userId));
  return (
    <div role="group" aria-label={`On this board now: ${names.join(", ")}`} data-testid="people-bar" className="flex items-center -space-x-1.5 px-1">
      {shown.map((entry) => (
        <Avatar key={entry.userId} person={people.get(entry.userId)} userId={entry.userId} size={28} />
      ))}
      {others.length > MAX_SHOWN && (
        <span title={names.slice(MAX_SHOWN).join(", ")} className="grid h-7 min-w-7 place-items-center rounded-full bg-ink-600 px-1 text-xs font-medium text-white ring-2 ring-ink-800">
          +{others.length - MAX_SHOWN}
        </span>
      )}
    </div>
  );
}
