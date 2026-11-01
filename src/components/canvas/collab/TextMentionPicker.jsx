"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { displayName } from "@/lib/board-access";
import { MENTION_CHIP_CLASS } from "@/lib/canvas/rich-text";
import { usePeople } from "@/lib/canvas/use-people";
import { Avatar } from "./Avatar";

const MAX_OPTIONS = 6;
const TRIGGER = /(^|\s)@([^\s@]{0,30})$/;

/** The `@query` right before the caret when the caret sits in a text node of `editor`, with where it starts. */
function triggerAt(editor) {
  const selection = window.getSelection();
  const node = selection?.anchorNode;
  if (!selection?.isCollapsed || !node || node.nodeType !== 3 || !editor.contains(node)) return null;
  if (node.parentElement?.closest("[data-mention]")) return null;
  const match = TRIGGER.exec(node.data.slice(0, selection.anchorOffset));
  if (!match) return null;
  const range = document.createRange();
  range.setStart(node, selection.anchorOffset - match[2].length - 1);
  range.setEnd(node, selection.anchorOffset);
  const rect = range.getBoundingClientRect();
  return { query: match[2], range, left: rect.left, top: rect.bottom + 4 };
}

/**
 * Typing @ in a board text, sticky or shape editor offers teammates; choosing one writes a mention chip
 * (a "m" mark over the @Name text). A chip is only a label: it notifies no one, unlike a mention in a comment.
 */
export function TextMentionPicker({ editorRef }) {
  const people = usePeople();
  const [open, setOpen] = useState(null);
  const [active, setActive] = useState(0);

  const options = useMemo(() => {
    if (!open) return [];
    const needle = open.query.toLowerCase();
    return [...people.values()]
      .filter((person) => displayName(person, person.id).toLowerCase().includes(needle))
      .sort((a, b) => displayName(a, a.id).localeCompare(displayName(b, b.id)))
      .slice(0, MAX_OPTIONS);
  }, [open, people]);

  const choose = useCallback((person) => {
    const editor = editorRef.current;
    const current = editor && triggerAt(editor);
    if (!current) return;
    const chip = document.createElement("span");
    chip.setAttribute("data-mention", person.id);
    chip.className = MENTION_CHIP_CLASS;
    chip.textContent = `@${displayName(person, person.id)}`;
    const space = document.createTextNode(" ");
    current.range.deleteContents();
    current.range.insertNode(space);
    current.range.insertNode(chip);
    const caret = document.createRange();
    caret.setStartAfter(space);
    caret.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(caret);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    setOpen(null);
  }, [editorRef]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return undefined;
    const refresh = () => {
      const next = triggerAt(editor);
      setOpen(next);
      if (!next) return;
      setActive(0);
    };
    const onKey = (event) => {
      if (!open || !options.length) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        setActive((index) => (index + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
      } else if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        choose(options[Math.min(active, options.length - 1)]);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(null);
      }
    };
    editor.addEventListener("input", refresh);
    editor.addEventListener("keydown", onKey);
    editor.addEventListener("blur", () => setOpen(null));
    return () => {
      editor.removeEventListener("input", refresh);
      editor.removeEventListener("keydown", onKey);
    };
  }, [editorRef, open, options, active, choose]);

  if (!open || options.length === 0) return null;
  return createPortal(
    <ul role="listbox" aria-label="Mention a teammate" className="fixed z-[60] w-56 overflow-hidden rounded-lg border border-line bg-ink-750 py-1 shadow-pop" style={{ left: Math.min(open.left, window.innerWidth - 232), top: Math.min(open.top, window.innerHeight - 220) }}>
      {options.map((person, index) => (
        <li key={person.id} role="option" aria-selected={index === active}>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => choose(person)} className={cn("flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-white/85", index === active && "bg-white/10")}>
            <Avatar person={person} userId={person.id} size={20} />
            <span className="truncate">{displayName(person, person.id)}</span>
          </button>
        </li>
      ))}
    </ul>,
    document.body
  );
}
