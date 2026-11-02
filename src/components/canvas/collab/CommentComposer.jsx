"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { displayName } from "@/lib/board-access";
import { GROUP_MENTIONS, MAX_COMMENT_LENGTH, insertMention, loadDraft, mentionQueryAt, mentionToken, saveDraft } from "@/lib/canvas/comments";
import { useCommentsStore } from "@/lib/canvas/comments-store";
import { usePeople } from "@/lib/canvas/use-people";
import { Avatar } from "./Avatar";

const MAX_OPTIONS = 6;

/**
 * Writes a comment or a reply. The text is kept as a draft in this browser until it is posted, and typing
 * @ offers people (those already in the thread and on the board first) and the groups board, team and space.
 */
export function CommentComposer({ boardId, threadId = null, autoFocus = false, placeholder = "Write a comment, @ to mention", initial, submitLabel = "Post", onSubmit, onCancel }) {
  const people = usePeople();
  const suggested = useCommentsStore((s) => s.suggested);
  const [text, setText] = useState(() => initial ?? loadDraft(boardId, threadId));
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const field = useRef(null);
  const isDraft = initial === undefined;

  useEffect(() => {
    if (isDraft) saveDraft(boardId, threadId, text);
  }, [boardId, threadId, text, isDraft]);
  useEffect(() => {
    if (autoFocus) field.current?.focus();
  }, [autoFocus]);

  const query = mentionQueryAt(text, caret);
  const options = useMemo(() => {
    if (!query) return [];
    const needle = query.query.toLowerCase();
    const rank = new Map(suggested.map((id, index) => [id, index]));
    const matches = [...people.values()]
      .filter((person) => displayName(person, person.id).toLowerCase().includes(needle))
      .sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999) || displayName(a, a.id).localeCompare(displayName(b, b.id)))
      .map((person) => ({ key: person.id, label: displayName(person, person.id), target: `user:${person.id}`, person }));
    const groups = GROUP_MENTIONS.filter((group) => group.label.startsWith(needle)).map((group) => ({ key: group.target, label: group.label, target: group.target, hint: group.hint }));
    return [...groups, ...matches].slice(0, MAX_OPTIONS);
  }, [query, people, suggested]);

  const choose = (option) => {
    const next = insertMention(text, caret, query, mentionToken(option.label, option.target));
    setText(next.text);
    setCaret(next.caret);
    setActive(0);
    requestAnimationFrame(() => {
      field.current?.focus();
      field.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const submit = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(body);
      if (isDraft) {
        saveDraft(boardId, threadId, "");
        setText("");
      }
    } catch (failure) {
      setError(failure.message || "Could not post the comment.");
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event) => {
    event.stopPropagation();
    if (options.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setActive((index) => (index + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        choose(options[Math.min(active, options.length - 1)]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setCaret(0);
        return;
      }
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    } else if (event.key === "Escape" && onCancel) {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="relative">
      <textarea
        ref={field}
        value={text}
        rows={2}
        maxLength={MAX_COMMENT_LENGTH}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => {
          setText(event.target.value);
          setCaret(event.target.selectionStart);
          setActive(0);
        }}
        onSelect={(event) => setCaret(event.target.selectionStart)}
        onKeyDown={onKeyDown}
        className="block w-full resize-none rounded-lg border border-line bg-ink-900 px-2.5 py-2 text-sm text-white placeholder:text-white/35 focus:border-white/40 focus:outline-none"
      />
      {options.length > 0 && (
        <ul role="listbox" aria-label="Mention suggestions" className="absolute bottom-full left-0 z-10 mb-1 w-full overflow-hidden rounded-lg border border-line bg-ink-750 py-1 shadow-pop">
          {options.map((option, index) => (
            <li key={option.key} role="option" aria-selected={index === active}>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(option)}
                className={cn("flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-white/85", index === active && "bg-white/10")}
              >
                {option.person ? <Avatar person={option.person} userId={option.key} size={20} /> : <span className="grid h-5 w-5 place-items-center rounded-full bg-mention/30 text-[11px] text-mention">@</span>}
                <span className="truncate">{option.label}</span>
                {option.hint && <span className="ml-auto truncate text-xs text-white/40">{option.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="mt-1 text-xs text-red-300">{error}</p>}
      <div className="mt-1.5 flex items-center justify-end gap-2">
        {onCancel && (
          <button type="button" onClick={onCancel} className="rounded-md px-2 py-1 text-xs text-white/60 hover:bg-white/10 hover:text-white">
            Cancel
          </button>
        )}
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !text.trim()}
          className="inline-flex items-center gap-1 rounded-md bg-white px-2.5 py-1 text-xs font-medium text-ink-900 disabled:opacity-40"
        >
          <Send className="h-3 w-3" /> {submitLabel}
        </button>
      </div>
    </div>
  );
}
