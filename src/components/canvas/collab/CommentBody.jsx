"use client";

import { cn } from "@/lib/utils";
import { bodyParts } from "@/lib/canvas/comments";

/** A comment's text with its @mentions as chips; the viewer's own mention is highlighted. */
export function CommentBody({ body, currentUserId, className }) {
  return (
    <p className={cn("whitespace-pre-wrap break-words text-sm text-white/85", className)}>
      {bodyParts(body).map((part, index) =>
        part.type === "text" ? (
          part.text
        ) : (
          <span
            key={index}
            data-mention={part.target}
            className={cn(
              "rounded bg-mention/20 px-1 font-medium text-mention",
              part.userId && part.userId === String(currentUserId ?? "").toLowerCase() && "bg-mention/40 text-white"
            )}
          >
            @{part.label}
          </span>
        )
      )}
    </p>
  );
}
