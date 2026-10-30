"use client";

import { useState } from "react";
import { Check, Crosshair, Pencil, RectangleHorizontal, SmilePlus, Square, Tag, Trash2 } from "lucide-react";
import { Dropdown } from "@/components/Dropdown";
import { useCanvasStore } from "@/lib/canvas-store";
import { REACTION_EMOJIS } from "@/lib/canvas/reactions";
import { stickyShape } from "@/lib/canvas/stickies";
import {
  addTagToSelection,
  currentUserId,
  editTag,
  removeTag,
  selectByTag,
  setReactionOnSelection,
  setSelectedStickyShape,
  setTagOnSelection,
} from "@/lib/canvas/sticky-actions";
import { findTagByName, searchTags, TAG_COLORS } from "@/lib/canvas/tags";
import { cn } from "@/lib/utils";

const SEGMENT = "grid h-7 w-7 place-items-center rounded-md transition";
const SEGMENT_ON = "bg-ink-600 text-white ring-1 ring-line";
const SEGMENT_OFF = "text-white/50 hover:text-white";
const ICON_TRIGGER = "grid h-8 w-8 cursor-pointer place-items-center rounded-lg text-white/60 transition hover:bg-white/[0.08] hover:text-white";

/** Square or rectangle for the selected stickies. */
export function StickyShapeControl({ stickies }) {
  const shape = stickyShape(stickies[0]);
  return (
    <div className="flex items-center gap-0.5 rounded-lg bg-ink-800 p-0.5" role="group" aria-label="Sticky shape">
      <button type="button" aria-label="Square sticky" title="Square" aria-pressed={shape === "square"}
        onClick={() => setSelectedStickyShape("square")} className={cn(SEGMENT, shape === "square" ? SEGMENT_ON : SEGMENT_OFF)}>
        <Square className="h-3.5 w-3.5" />
      </button>
      <button type="button" aria-label="Rectangular sticky" title="Rectangle" aria-pressed={shape === "rectangle"}
        onClick={() => setSelectedStickyShape("rectangle")} className={cn(SEGMENT, shape === "rectangle" ? SEGMENT_ON : SEGMENT_OFF)}>
        <RectangleHorizontal className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/** Auto font size on the selected stickies: the text shrinks or grows to fill the note. */
export function AutoFitButton({ on, onChange }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label="Auto font size"
      title="Auto font size"
      onClick={() => onChange(!on)}
      className={cn("h-8 rounded-lg px-2 text-xs font-medium transition", on ? "bg-brand/20 text-brand" : "text-white/55 hover:bg-white/[0.08] hover:text-white")}
    >
      Auto
    </button>
  );
}

/** Tags on the selected stickies: search, add, create, rename, recolor, delete and select by tag. */
export function TagPicker({ stickies }) {
  const tags = useCanvasStore((s) => s.history.present.tags) ?? [];
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState(null);
  const shown = searchTags(tags, query);
  const canCreate = query.trim() && !findTagByName(tags, query);
  const onAll = (id) => stickies.every((node) => node.tagIds?.includes(id));
  return (
    <Dropdown
      label="Tags"
      onOpen={() => {
        setQuery("");
        setEditingId(null);
      }}
      trigger={(open) => (
        <span aria-label="Tags" title="Tags" className={cn(ICON_TRIGGER, open && "bg-white/[0.08] text-white")}>
          <Tag className="h-4 w-4" />
        </span>
      )}
    >
      {() => (
        <div className="w-60" data-tag-picker="">
          <input
            autoFocus
            value={query}
            maxLength={60}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || !query.trim()) return;
              e.preventDefault();
              const existing = findTagByName(tags, query);
              if (existing) setTagOnSelection(existing.id, true);
              else addTagToSelection(query);
              setQuery("");
            }}
            placeholder="Find or create a tag"
            aria-label="Find or create a tag"
            className="mb-1 h-8 w-full rounded-lg border border-line bg-ink-800 px-2 text-xs text-white outline-none placeholder:text-white/30 focus:border-brand/40"
          />
          <div className="max-h-64 overflow-y-auto">
            {shown.map((tag) => (
              <div key={tag.id}>
                <div className="group flex items-center gap-1 rounded-lg px-1 hover:bg-white/6">
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={onAll(tag.id)}
                    onClick={() => setTagOnSelection(tag.id, !onAll(tag.id))}
                    className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-1 text-left text-sm text-white/80"
                  >
                    <span className="grid h-4 w-4 shrink-0 place-items-center rounded border border-white/25">
                      {onAll(tag.id) && <Check className="h-3 w-3 text-white" />}
                    </span>
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: tag.color }} />
                    <span className="truncate">{tag.name}</span>
                  </button>
                  <button type="button" aria-label={`Select everything tagged ${tag.name}`} title="Select everything with this tag"
                    onClick={() => selectByTag(tag.id)} className="grid h-6 w-6 shrink-0 place-items-center rounded text-white/45 hover:text-white">
                    <Crosshair className="h-3.5 w-3.5" />
                  </button>
                  <button type="button" aria-label={`Edit tag ${tag.name}`} title="Edit tag" aria-expanded={editingId === tag.id}
                    onClick={() => setEditingId(editingId === tag.id ? null : tag.id)} className="grid h-6 w-6 shrink-0 place-items-center rounded text-white/45 hover:text-white">
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                </div>
                {editingId === tag.id && <TagEditor tag={tag} onDone={() => setEditingId(null)} />}
              </div>
            ))}
            {canCreate && (
              <button
                type="button"
                onClick={() => {
                  addTagToSelection(query);
                  setQuery("");
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-white/75 hover:bg-white/6 hover:text-white"
              >
                <span className="truncate">Create tag &quot;{query.trim()}&quot;</span>
              </button>
            )}
            {!shown.length && !canCreate && <p className="px-2 py-1.5 text-xs text-white/40">No tags yet. Type a name to create one.</p>}
          </div>
        </div>
      )}
    </Dropdown>
  );
}

function TagEditor({ tag, onDone }) {
  const [name, setName] = useState(tag.name);
  const save = () => {
    if (name.trim() && name !== tag.name) editTag(tag.id, { name });
  };
  return (
    <div className="mx-1 mb-1 rounded-lg border border-line bg-ink-800 p-1.5">
      <input
        value={name}
        maxLength={60}
        aria-label="Tag name"
        onChange={(e) => setName(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save();
            onDone();
          }
        }}
        className="h-7 w-full rounded-md border border-line bg-ink-750 px-2 text-xs text-white outline-none focus:border-brand/40"
      />
      <div className="mt-1.5 flex items-center gap-1">
        {TAG_COLORS.map((color) => (
          <button key={color} type="button" aria-label={`Tag color ${color}`} aria-pressed={tag.color === color}
            onClick={() => editTag(tag.id, { color })}
            className={cn("h-4 w-4 rounded-full", tag.color === color && "ring-2 ring-white/80 ring-offset-1 ring-offset-ink-800")}
            style={{ background: color }} />
        ))}
        <button type="button" aria-label={`Delete tag ${tag.name}`} title="Delete tag everywhere"
          onClick={() => {
            removeTag(tag.id);
            onDone();
          }}
          className="ml-auto grid h-6 w-6 place-items-center rounded text-red-300/80 hover:bg-red-500/10">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

/** Vote on the selected stickies with an emoji; picking one you already gave takes it back. */
export function ReactionPicker({ stickies }) {
  const userId = currentUserId();
  const mineOnAll = (emoji) => Boolean(userId) && stickies.every((node) => node.reactions?.[emoji]?.includes(userId));
  return (
    <Dropdown
      label="React"
      trigger={(open) => (
        <span aria-label="React" title="React" className={cn(ICON_TRIGGER, open && "bg-white/[0.08] text-white")}>
          <SmilePlus className="h-4 w-4" />
        </span>
      )}
    >
      {(close) => (
        <div className="grid grid-cols-6 gap-1" data-reaction-picker="">
          {REACTION_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`React ${emoji}`}
              aria-pressed={mineOnAll(emoji)}
              onClick={() => {
                setReactionOnSelection(emoji, !mineOnAll(emoji));
                close();
              }}
              className={cn("grid h-8 w-8 place-items-center rounded-lg text-lg transition hover:bg-white/10", mineOnAll(emoji) && "bg-brand/20")}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </Dropdown>
  );
}
