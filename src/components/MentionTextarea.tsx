"use client";

import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  forwardRef,
  type KeyboardEvent,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { TAG_REGEX, isImgTag } from "@/lib/mentions";
import { cn } from "@/lib/utils";

export interface MentionHandle {
  insertTag: (tag: string) => void;
  focus: () => void;
}

export interface AssetRef {
  slug: string;
  name: string;
  kind: string;
  thumb?: string;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  references: string[]; // data URLs; index+1 => @imgN
  assets?: AssetRef[]; // named asset tags (@slug)
  placeholder?: string;
  className?: string;
}

interface Suggestion {
  tag: string; // includes leading "@"
  label: string; // "@img1" or "@priya"
  sub?: string; // secondary text (asset name · kind)
  thumb?: string;
}

// Shared typography so the highlight overlay lines up 1:1 with the textarea.
const TYPO =
  "px-1 py-2 text-[15px] leading-relaxed font-sans whitespace-pre-wrap break-words";

export const MentionTextarea = forwardRef<MentionHandle, Props>(
  function MentionTextarea(
    { value, onChange, onSubmit, references, assets = [], placeholder, className },
    ref
  ) {
    const taRef = useRef<HTMLTextAreaElement>(null);
    const highlightRef = useRef<HTMLDivElement>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [activeIdx, setActiveIdx] = useState(0);

    const tagCount = references.length;
    const assetSlugs = new Set(assets.map((a) => a.slug));

    // Unified suggestion list: ad-hoc uploads (@imgN) + named assets (@slug).
    const q = query.toLowerCase();
    const imgSuggestions: Suggestion[] = Array.from(
      { length: tagCount },
      (_, i) => i + 1
    )
      .filter((n) => `img${n}`.startsWith(q))
      .map((n) => ({
        tag: `@img${n}`,
        label: `@img${n}`,
        sub: "uploaded image",
        thumb: references[n - 1],
      }));
    const assetSuggestions: Suggestion[] = assets
      .filter((a) => a.slug.startsWith(q) || a.name.toLowerCase().includes(q))
      .map((a) => ({
        tag: `@${a.slug}`,
        label: `@${a.slug}`,
        sub: `${a.name} · ${a.kind}`,
        thumb: a.thumb,
      }));
    const available: Suggestion[] = [...assetSuggestions, ...imgSuggestions];

    const autosize = () => {
      const ta = taRef.current;
      if (!ta) return;
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 180) + "px";
    };

    useEffect(() => {
      autosize();
    }, [value]);

    useImperativeHandle(ref, () => ({
      insertTag: (tag: string) => {
        const ta = taRef.current;
        const caret = ta ? ta.selectionStart : value.length;
        const before = value.slice(0, caret).replace(/\s*$/, "");
        const after = value.slice(caret);
        const next = `${before}${before ? " " : ""}${tag} ${after.replace(/^\s*/, "")}`;
        onChange(next);
        requestAnimationFrame(() => {
          ta?.focus();
          const pos = (before ? before.length + 1 : 0) + tag.length + 1;
          ta?.setSelectionRange(pos, pos);
          autosize();
        });
      },
      focus: () => taRef.current?.focus(),
    }));

    const syncScroll = () => {
      if (highlightRef.current && taRef.current) {
        highlightRef.current.scrollTop = taRef.current.scrollTop;
      }
    };

    const hasSuggestions = tagCount > 0 || assets.length > 0;

    const detectMention = (text: string, caret: number) => {
      const slice = text.slice(0, caret);
      const m = slice.match(/(^|\s)@([\w-]*)$/);
      if (m && hasSuggestions) {
        setQuery(m[2] || "");
        setActiveIdx(0);
        setMenuOpen(true);
      } else {
        setMenuOpen(false);
      }
    };

    const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const v = e.target.value;
      onChange(v);
      detectMention(v, e.target.selectionStart);
    };

    const selectTag = (tag: string) => {
      const ta = taRef.current;
      if (!ta) return;
      const caret = ta.selectionStart;
      const slice = value.slice(0, caret);
      const at = slice.lastIndexOf("@");
      if (at < 0) return;
      const next = value.slice(0, at) + tag + " " + value.slice(caret);
      onChange(next);
      setMenuOpen(false);
      requestAnimationFrame(() => {
        const pos = at + tag.length + 1;
        ta.focus();
        ta.setSelectionRange(pos, pos);
        autosize();
      });
    };

    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (menuOpen && available.length) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setActiveIdx((i) => (i + 1) % available.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setActiveIdx((i) => (i - 1 + available.length) % available.length);
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          selectTag(available[activeIdx].tag);
          return;
        }
        if (e.key === "Escape") {
          setMenuOpen(false);
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        onSubmit();
      }
    };

    return (
      <div className="relative flex-1">
        {/* highlight overlay (paint-only; background/color don't shift layout) */}
        <div
          ref={highlightRef}
          aria-hidden
          className={cn(
            "scroll-none pointer-events-none absolute inset-0 max-h-[180px] overflow-hidden text-white/90",
            TYPO
          )}
        >
          {renderHighlighted(value, tagCount, assetSlugs)}
          {"\n"}
        </div>

        <textarea
          ref={taRef}
          value={value}
          onChange={handleChange}
          onKeyDown={onKeyDown}
          onScroll={syncScroll}
          onClick={(e) => detectMention(value, e.currentTarget.selectionStart)}
          onKeyUp={(e) => detectMention(value, e.currentTarget.selectionStart)}
          onBlur={() => setTimeout(() => setMenuOpen(false), 120)}
          rows={2}
          placeholder={placeholder}
          className={cn(
            "scroll-thin relative max-h-[180px] min-h-[58px] w-full resize-none bg-transparent text-transparent caret-white outline-none placeholder:text-white/35",
            TYPO,
            className
          )}
        />

        {/* @ autocomplete */}
        <AnimatePresence>
          {menuOpen && available.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.97 }}
              transition={{ type: "spring", stiffness: 480, damping: 32 }}
              className="absolute bottom-[calc(100%+8px)] left-0 z-50 max-h-64 w-64 overflow-y-auto scroll-thin rounded-xl border border-line bg-ink-750/95 p-1.5 shadow-pop backdrop-blur-xl"
            >
              <p className="px-2 py-1 text-[10px] uppercase tracking-wide text-white/35">
                Reference asset
              </p>
              {available.map((sug, i) => (
                <button
                  key={sug.tag}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectTag(sug.tag);
                  }}
                  onMouseEnter={() => setActiveIdx(i)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors",
                    i === activeIdx ? "bg-brand/15 text-white" : "text-white/75"
                  )}
                >
                  {sug.thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={sug.thumb}
                      alt=""
                      className="h-8 w-8 rounded-md object-cover ring-1 ring-line"
                    />
                  ) : (
                    <span className="grid h-8 w-8 place-items-center rounded-md bg-ink-700 text-brand ring-1 ring-line">
                      @
                    </span>
                  )}
                  <span className="flex min-w-0 flex-col">
                    <span className="font-medium text-brand">{sug.label}</span>
                    {sug.sub && (
                      <span className="truncate text-[11px] text-white/40">
                        {sug.sub}
                      </span>
                    )}
                  </span>
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }
);

/** Split text into plain runs and @tag tokens; valid tags get a brand highlight,
 *  unknown ones go red. A tag is valid if it's an in-range @imgN or a known
 *  asset slug. */
function renderHighlighted(
  text: string,
  tagCount: number,
  assetSlugs: Set<string>
) {
  const out: React.ReactNode[] = [];
  const re = new RegExp(TAG_REGEX);
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const slug = m[1].toLowerCase();
    const n = parseInt(slug.slice(3), 10);
    const valid = isImgTag(slug)
      ? n >= 1 && n <= tagCount
      : assetSlugs.has(slug);
    out.push(
      <span
        key={key++}
        className={cn(
          "rounded-sm",
          valid ? "bg-brand/25 text-brand" : "bg-red-500/20 text-red-300"
        )}
      >
        {m[0]}
      </span>
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
