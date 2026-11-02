"use client";

import { cn } from "@/lib/utils";
import { displayName } from "@/lib/board-access";

/** A person's picture, or their initial on their colour. */
export function Avatar({ person, userId, size = 24, className }) {
  const name = displayName(person, userId);
  const style = { width: size, height: size, fontSize: Math.max(10, size * 0.42), backgroundColor: person?.color || "#64748b" };
  return person?.avatarUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={person.avatarUrl} alt="" title={name} style={style} className={cn("shrink-0 rounded-full object-cover ring-2 ring-ink-800", className)} />
  ) : (
    <span title={name} style={style} className={cn("grid shrink-0 place-items-center rounded-full font-semibold text-white ring-2 ring-ink-800", className)}>
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}
