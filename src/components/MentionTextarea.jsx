"use client";

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  forwardRef,

} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useIsPresent } from "framer-motion";
import { Search } from "lucide-react";
import { normalizePromptMentions, syncMentionTagCorrection } from "@/lib/mentions";
import { cn, referenceDisplayUrl } from "@/lib/utils";


// Admin-configurable ceiling (src/lib/settings.js) — purely a display aid
// here (counter appears once within WARN_RATIO of it, turns red past it).
// Never blocks typing/pasting: the actual submit-time gate lives in the
// caller (disable Generate) and, as the real enforcement, server-side in
// generate/image and generate/video.
const WARN_RATIO = 0.8;


// Shared typography so the highlight overlay lines up 1:1 with the textarea.
// `scroll-none` is load-bearing, not cosmetic. The real <textarea> used to
// carry `scroll-thin` (a visible ~8px scrollbar) while this overlay div —
// `overflow-hidden`, so it never scrolls or reserves scrollbar space at all
// — did not. Once a prompt got long enough to need scrolling, that 8px ate
// into only the textarea's available text-wrapping width, so the two layers
// wrapped the same text differently, a divergence that compounds with every
// wrapped line. A click translates a visual (overlay) position into a caret
// index in the (differently-wrapped) real textarea, so the caret lands
// increasingly far from where it visually appears the further into the text
// the click is — reported as "typing lands behind the cursor, worse further
// from the start." (On macOS this was intermittent-looking because a
// classic, space-consuming scrollbar only appears with a physical mouse
// connected; trackpad shows a non-consuming overlay one — but the root
// cause is this class mismatch, not the input device.) `scroll-none` keeps
// the textarea scrollable via wheel/keyboard/touch without ever consuming
// layout width for a scrollbar, so both layers always wrap identically.
const TYPO =
  "px-1 py-2 text-[15px] leading-relaxed font-sans whitespace-pre-wrap break-words scroll-none";

// Every property that can affect where a browser breaks a line or kerns a
// character, applied identically to both layers via inline style (not just
// shared classes) so nothing here can silently drift out of sync the way
// Tailwind class strings can when one layer's className prop grows a class
// the other doesn't get. Some of these (tab-size, text-rendering) have no
// commonly-supported Tailwind utility, hence inline style over classes.
const SYNCED_TEXT_STYLE = {
  boxSizing: "border-box",
  margin: 0,
  border: 0,
  letterSpacing: "normal",
  wordSpacing: "normal",
  tabSize: 4,
  textIndent: 0,
  textRendering: "auto",
  textTransform: "none",
};

export const MentionTextarea = forwardRef(
  function MentionTextarea(
    {
      value,
      onChange,
      onSubmit,
      // Enter-to-send. Correct for a chat box, wrong for the generation
      // composer: there Enter fires a real, billed image/video job, and the
      // prompts typed into it are long multi-line shot specs where reaching
      // for a newline is constant. PromptComposer passes false so only the
      // Send button submits; Shift+Enter still inserts a newline either way.
      submitOnEnter = true,
      references,
      // The strip's tag per image slot ("@sati" for an attached material); empty falls back to @imgN.
      referenceTags = [],
      videoRefs = [],
      audioRefs = [],
      assets = [],
      placeholder,
      className,
      maxLength,
      collapsed = false,
    },
    ref
  ) {
    const taRef = useRef(null);
    const highlightRef = useRef(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [activeIdx, setActiveIdx] = useState(0);
    // onKeyDown moves activeIdx (or closes/selects) for nav keys while the
    // menu is open; the browser then fires onKeyUp for the *same* keypress,
    // which used to call detectMention unconditionally — since neither the
    // text nor the caret moved, it re-matched the same @query and reset
    // activeIdx back to 0, silently undoing the ArrowUp/ArrowDown just
    // handled. This flag makes the matching keyup a no-op instead.
    const suppressNextKeyUp = useRef(false);

    const tagCount = references.length;
    const assetSlugs = new Set(assets.map((a) => (a.slug || "").toLowerCase()));

    // Unified suggestion list: ad-hoc uploads (@imgN) + named assets (@slug).
    const q = query.toLowerCase();
    const imgSuggestions = Array.from(
      { length: tagCount },
      (_, i) => i + 1
    )
      .filter((n) => matchesImgQuery(n, q))
      .map((n) => ({
        tag: `@img${n}`,
        label: `@img${n}`,
        sub: "uploaded image",
        thumb: referenceDisplayUrl(references[n - 1], assets),
      }));
    const assetSuggestions = assets
      .filter((a) => (a.slug || "").toLowerCase().startsWith(q) || (a.name || "").toLowerCase().includes(q))
      .map((a) => ({
        tag: `@${a.slug}`,
        label: `@${a.slug}`,
        sub: `${a.name} · ${a.kind}`,
        thumb: a.thumb || a.images?.[0],
      }));
    // Attached clips get their own tags. These were missing entirely, so typing
    // @vid1 offered nothing and highlighted red — the tag existed only in the
    const available = [
      ...assetSuggestions,
      ...imgSuggestions,
      ...attachedMediaSuggestions(q, videoRefs.length, audioRefs.length),
    ];
    // Every attached reference in strip order: what clicking a tag offers to replace it with.
    const attachedOptions = [
      ...references.map((reference, i) => {
        const tag = referenceTags[i] || `@img${i + 1}`;
        return { tag, label: tag, sub: referenceTags[i] ? "material" : "uploaded image", thumb: referenceDisplayUrl(reference, assets) };
      }),
      ...attachedMediaSuggestions("", videoRefs.length, audioRefs.length),
    ];
    // The tag whose "Replace … with" menu is open: where it starts, its text, and where the click
    // put the caret (restored when the menu is dismissed).
    const [replacing, setReplacing] = useState(null);
    // Each opening is a fresh menu, even on the tag whose previous menu is still fading out.
    const replaceMenuCount = useRef(0);
    useEffect(() => {
      if (replacing && !mentionTokens(value).some((t) => t.start === replacing.start && t.raw === replacing.raw)) setReplacing(null);
    }, [value, replacing]);

    // Keeps the keyboard-selected suggestion visible: the list scrolls
    // (max-h-64 overflow-y-auto) once it has more entries than fit, and
    // without this ArrowDown/ArrowUp could move activeIdx past the visible
    // window with no visual sign anything happened.
    const menuRef = useRef(null);
    const fieldRef = useRef(null);
    const [menuAnchor, setMenuAnchor] = useState(null);
    const showMenu = menuOpen && available.length > 0;
    // The menu floats above the field in a body portal, so a scrolling composer shell cannot clip it.
    useLayoutEffect(() => {
      if (!showMenu) return undefined;
      const place = () => {
        const rect = fieldRef.current?.getBoundingClientRect();
        if (rect) setMenuAnchor({ right: window.innerWidth - rect.right, bottom: window.innerHeight - rect.top + 8 });
      };
      place();
      window.addEventListener("resize", place);
      window.addEventListener("scroll", place, true);
      return () => {
        window.removeEventListener("resize", place);
        window.removeEventListener("scroll", place, true);
      };
    }, [showMenu]);
    const blurTimerRef = useRef(null);
    useEffect(() => () => {
      if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
    }, []);
    useEffect(() => {
      if (!menuOpen) return;
      menuRef.current
        ?.querySelector(`[data-suggestion-idx="${activeIdx}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }, [activeIdx, menuOpen]);

    const autosize = useCallback(() => {
      const ta = taRef.current;
      if (!ta) return;
      if (collapsed) {
        ta.style.height = "38px";
        ta.scrollTop = 0;
        if (highlightRef.current) {
          highlightRef.current.scrollTop = 0;
        }
        return;
      }
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 240) + "px";
      if (highlightRef.current) {
        highlightRef.current.scrollTop = ta.scrollTop;
      }
    }, [collapsed]);

    useEffect(() => {
      autosize();
    }, [value, autosize]);

    useImperativeHandle(ref, () => ({
      insertTag: (tag) => {
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

    const hasSuggestions =
      tagCount > 0 || assets.length > 0 || videoRefs.length > 0 || audioRefs.length > 0;

    const detectMention = (text, caret) => {
      const slice = text.slice(0, caret);
      const m = slice.match(/(^|\s)@([a-z0-9_-]*(?:\s+\d*)?)$/i);
      if (m && hasSuggestions) {
        setQuery(m[2] || "");
        setActiveIdx(0);
        setMenuOpen(true);
      } else {
        setMenuOpen(false);
      }
    };

    const handleChange = (e) => {
      const v = e.target.value;
      const caret = e.target.selectionStart;
      const { text: synced, caret: nextCaret, changed } = syncMentionTagCorrection(
        value,
        v,
        caret
      );
      if (changed) {
        onChange(synced);
        detectMention(synced, nextCaret);
        requestAnimationFrame(() => {
          taRef.current?.setSelectionRange(nextCaret, nextCaret);
        });
      } else {
        onChange(v);
        detectMention(v, caret);
      }
    };

    const selectTag = (tag) => {
      const ta = taRef.current;
      if (!ta) return;
      const caret = ta.selectionStart;
      const slice = value.slice(0, caret);
      const at = slice.lastIndexOf("@");
      if (at < 0) return;
      const next = value.slice(0, at) + tag + " " + value.slice(caret);
      const { text: syncedText, caret: syncedCaret } = syncMentionTagCorrection(
        value,
        next,
        at + tag.length + 1
      );
      onChange(syncedText);
      setMenuOpen(false);
      requestAnimationFrame(() => {
        const pos = syncedCaret;
        ta.focus();
        ta.setSelectionRange(pos, pos);
        autosize();
      });
    };

    const mentionSpan = (start) => highlightRef.current?.querySelector(`[data-mention-start="${start}"]`);

    // Higgsfield opens a "Replace @x with" menu when any tag is clicked, broken or not. Here a tag
    // is highlighted text, so the press must land on its highlight box, not merely leave the caret
    // at its edge (clicking just past a tag to keep typing). The box is read on pointerdown: a
    // collapsed composer expands on that press, so by `click` the text has moved.
    const pressedTag = useRef(null);
    const onPointerDown = (e) => {
      const hit = (r) => e.clientX >= r.left - 1 && e.clientX <= r.right + 1 && e.clientY >= r.top - 1 && e.clientY <= r.bottom + 1;
      pressedTag.current = mentionTokens(value).find((t) => [...(mentionSpan(t.start)?.getClientRects() || [])].some(hit)) || null;
    };
    const openReplaceMenu = (e) => {
      const ta = e.currentTarget;
      const pressed = pressedTag.current;
      pressedTag.current = null;
      if (!attachedOptions.length || ta.selectionStart !== ta.selectionEnd) return false;
      const caret = ta.selectionStart;
      const tokens = mentionTokens(value);
      // Without layout to hit-test (no boxes at all), a caret strictly inside a tag counts instead.
      const token = highlightRef.current?.getClientRects().length
        ? pressed && tokens.find((t) => t.start === pressed.start && t.raw === pressed.raw)
        : tokens.find((t) => caret > t.start && caret < t.end);
      if (!token) return false;
      setMenuOpen(false);
      replaceMenuCount.current += 1;
      setReplacing({ id: replaceMenuCount.current, start: token.start, raw: token.raw, caret });
      return true;
    };

    const focusCaret = (pos) => {
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(pos, pos);
        autosize();
      });
    };

    const replaceTag = (tag) => {
      const result = replacing && replaceTagEverywhere(value, replacing.start, tag);
      setReplacing(null);
      if (!result) return;
      onChange(result.text);
      focusCaret(result.caret);
    };

    const closeReplaceMenu = (refocus) => {
      const caret = replacing?.caret;
      setReplacing(null);
      if (refocus && caret !== undefined) focusCaret(caret);
    };

    const onKeyDown = (e) => {
      if (menuOpen && available.length) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          suppressNextKeyUp.current = true;
          setActiveIdx((i) => (i + 1) % available.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          suppressNextKeyUp.current = true;
          setActiveIdx((i) => (i - 1 + available.length) % available.length);
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          suppressNextKeyUp.current = true;
          selectTag(available[activeIdx].tag);
          return;
        }
        if (e.key === "Escape") {
          suppressNextKeyUp.current = true;
          setMenuOpen(false);
          return;
        }
      }
      if (submitOnEnter && e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        suppressNextKeyUp.current = true;
        onSubmit();
      }
    };

    return (
      <div ref={fieldRef} className="relative min-w-0 flex-1">
        {/* highlight overlay (paint-only; background/color don't shift layout) */}
        <div
          ref={highlightRef}
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 overflow-hidden text-white/90",
            // Collapsed, the overlay stops at the end of the first line so the next line cannot peek
            // through the bottom padding.
            collapsed ? "max-h-[calc(0.5rem+1lh)]" : "max-h-[240px]",
            TYPO,
            className
          )}
          style={SYNCED_TEXT_STYLE}
        >
          {renderHighlighted(value, tagCount, assetSlugs, videoRefs.length, audioRefs.length)}
          {"\n"}
        </div>

        <textarea
          ref={taRef}
          value={value}
          onChange={handleChange}
          onKeyDown={onKeyDown}
          onScroll={syncScroll}
          onPointerDown={onPointerDown}
          onClick={(e) => {
            if (!openReplaceMenu(e)) detectMention(value, e.currentTarget.selectionStart);
          }}
          onKeyUp={(e) => {
            if (suppressNextKeyUp.current) {
              suppressNextKeyUp.current = false;
              return;
            }
            detectMention(value, e.currentTarget.selectionStart);
          }}
          onBlur={() => {
            if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
            blurTimerRef.current = setTimeout(() => {
              blurTimerRef.current = null;
              setMenuOpen(false);
            }, 120);
          }}
          rows={collapsed ? 1 : 3}
          placeholder={placeholder}
          className={cn(
            // Deliberately NOT scroll-thin: a visible scrollbar (any width)
            // narrows this element's text-wrapping width relative to the
            // overlay div above, which never shows one — see TYPO's comment.
            "relative w-full resize-none bg-transparent text-transparent caret-white outline-none placeholder:text-white/35",
            collapsed ? "max-h-[38px] min-h-[38px]" : "max-h-[240px] min-h-[76px]",
            TYPO,
            className
          )}
          style={SYNCED_TEXT_STYLE}
        />

        {/* Character counter — only surfaces once it's actually relevant
            (near or over the admin-configured limit), so a normal short
            prompt never carries this clutter. */}
        {maxLength && value.length > maxLength * WARN_RATIO && (
          <span
            className={cn(
              "pointer-events-none absolute bottom-1 right-1.5 rounded bg-ink-900/80 px-1.5 py-0.5 text-[11px] tabular-nums",
              value.length > maxLength ? "text-red-400" : "text-white/45"
            )}
          >
            {value.length.toLocaleString()} / {maxLength.toLocaleString()}
          </span>
        )}

        {/* @ autocomplete */}
        {typeof document !== "undefined" && createPortal(<AnimatePresence>
          {showMenu && (
            <motion.div
              ref={menuRef}
              role="listbox"
              initial={{ opacity: 0, y: 6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.97 }}
              transition={{ type: "spring", stiffness: 480, damping: 32 }}
              style={{ right: menuAnchor?.right ?? 8, bottom: menuAnchor?.bottom ?? 8, visibility: menuAnchor ? "visible" : "hidden" }}
              className="scroll-thin fixed z-[100] max-h-64 w-[min(16rem,calc(100vw-1rem))] overflow-y-auto rounded-xl border border-line bg-ink-750/95 p-1.5 shadow-pop backdrop-blur-xl"
            >
              <p className="px-2 py-1 text-[10px] uppercase tracking-wide text-white/35">
                Reference asset
              </p>
              {available.map((sug, i) => (
                <SuggestionRow
                  key={sug.tag}
                  suggestion={sug}
                  index={i}
                  active={i === activeIdx}
                  assets={assets}
                  onPick={selectTag}
                  onHover={setActiveIdx}
                />
              ))}
            </motion.div>
          )}
        </AnimatePresence>, document.body)}

        {typeof document !== "undefined" && createPortal(<AnimatePresence>
          {replacing && (
            <TagReplaceMenu
              key={replacing.id}
              raw={replacing.raw}
              anchorRect={() => mentionSpan(replacing.start)?.getBoundingClientRect() ?? fieldRef.current?.getBoundingClientRect()}
              options={attachedOptions}
              assets={assets}
              onPick={replaceTag}
              onClose={closeReplaceMenu}
            />
          )}
        </AnimatePresence>, document.body)}
      </div>
    );
  }
);

function SuggestionRow({ suggestion: sug, index, active, assets, onPick, onHover, id }) {
  return (
    <button
      type="button"
      id={id}
      role="option"
      aria-selected={active}
      data-suggestion-idx={index}
      onMouseDown={(e) => {
        e.preventDefault();
        onPick(sug.tag);
      }}
      onMouseEnter={() => onHover(index)}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors",
        active ? "bg-brand/15 text-white" : "text-white/75"
      )}
    >
      {sug.thumb ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={referenceDisplayUrl(sug.thumb, assets)}
          alt=""
          className="h-8 w-8 shrink-0 rounded-md object-cover ring-1 ring-line"
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
        />
      ) : (
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-ink-700 text-mention ring-1 ring-line">
          @
        </span>
      )}
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium text-mention">{sug.label}</span>
        {sug.sub && (
          <span className="truncate text-[11px] text-white/40">
            {sug.sub}
          </span>
        )}
      </span>
    </button>
  );
}

const MENU_GAP = 8;
const VIEWPORT_EDGE = 8;

/**
 * Higgsfield Cinema Studio's tag menu: "Replace @x with:", a search field, then every attached
 * reference. It opens under the clicked tag (above it when there is no room below), centred on
 * it. Focus moves to the search field; ArrowDown/ArrowUp move a highlight that starts on nothing
 * and stops at either end, Enter picks, Escape closes and returns the caret to the prompt.
 */
function TagReplaceMenu({ raw, anchorRect, options, assets, onPick, onClose }) {
  const menuRef = useRef(null);
  const inputRef = useRef(null);
  // False while the menu fades out after a pick or dismissal; it no longer takes clicks then.
  const present = useIsPresent();
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(-1);
  const [position, setPosition] = useState(null);
  const q = query.trim().toLowerCase().replace(/^@/, "");
  const shown = options.filter((o) => !q || `${o.label} ${o.sub || ""}`.toLowerCase().includes(q));

  const latest = useRef({ anchorRect, onClose, present });
  latest.current = { anchorRect, onClose, present };

  // Above or below is decided once, when the menu opens, so filtering never flips it across the
  // tag. The menu then follows the tag every frame while open: a collapsed composer animates open
  // under the very click that opened it, and scrolling or resizing moves the tag too.
  const placement = useRef(null);
  useLayoutEffect(() => {
    let frame = 0;
    let last = "";
    const place = () => {
      // A fading menu stays put; its tag may already be rewritten.
      const rect = latest.current.present && latest.current.anchorRect();
      const menu = menuRef.current;
      if (rect && menu) {
        const width = menu.offsetWidth;
        if (!placement.current) {
          const roomBelow = window.innerHeight - rect.bottom - MENU_GAP - VIEWPORT_EDGE;
          const roomAbove = rect.top - MENU_GAP - VIEWPORT_EDGE;
          placement.current = menu.offsetHeight <= roomBelow || roomBelow >= roomAbove ? "below" : "above";
        }
        const left = Math.round(Math.max(VIEWPORT_EDGE, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - VIEWPORT_EDGE)));
        const next = placement.current === "below"
          ? { left, top: Math.round(rect.bottom + MENU_GAP) }
          : { left, bottom: Math.round(window.innerHeight - rect.top + MENU_GAP) };
        const key = JSON.stringify(next);
        if (key !== last) {
          last = key;
          setPosition(next);
        }
      }
      frame = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(frame);
  }, []);

  // Focus waits for the first placement: a hidden field cannot take it.
  const placed = Boolean(position);
  useEffect(() => {
    if (placed) inputRef.current?.focus({ preventScroll: true });
  }, [placed]);

  useEffect(() => {
    const dismiss = (e) => {
      if (!menuRef.current?.contains(e.target)) latest.current.onClose(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, []);

  useEffect(() => {
    menuRef.current?.querySelector(`[data-suggestion-idx="${activeIdx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  const onKeyDown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, shown.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => (i < 0 ? shown.length - 1 : Math.max(i - 1, 0)));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (shown[activeIdx]) onPick(shown[activeIdx].tag);
    } else if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      onClose(true);
    }
  };

  return (
    // Position and visibility sit on a plain element React updates synchronously: motion applies
    // its style a frame later, and the search field cannot take focus while still hidden.
    <div
      ref={menuRef}
      role="dialog"
      aria-label={`Replace ${raw}`}
      data-tag-replace-menu={present ? "open" : "closing"}
      style={position || undefined}
      className={cn("fixed z-[100] w-[min(15rem,calc(100vw-1rem))]", !position && "invisible", !present && "pointer-events-none")}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.97 }}
        transition={{ type: "spring", stiffness: 480, damping: 32 }}
        className="rounded-xl border border-line bg-ink-750/95 p-1.5 shadow-pop backdrop-blur-xl"
      >
        <p className="truncate px-2 pb-1.5 pt-1 text-xs text-white/50">Replace {raw} with:</p>
        <label className="mx-0.5 mb-1 flex items-center gap-2 rounded-lg bg-ink-900/70 px-2 ring-1 ring-line focus-within:ring-mention/60">
          <Search aria-hidden className="h-3.5 w-3.5 shrink-0 text-white/40" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIdx(e.target.value.trim() ? 0 : -1);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search"
            aria-label="Search references"
            role="combobox"
            aria-expanded="true"
            aria-controls="tag-replace-options"
            aria-activedescendant={shown[activeIdx] ? `tag-replace-option-${activeIdx}` : undefined}
            className="h-8 min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/35"
          />
        </label>
        <div id="tag-replace-options" role="listbox" aria-label="Attached references" className="scroll-thin max-h-56 overflow-y-auto">
          {shown.map((option, i) => (
            <SuggestionRow
              key={`${option.tag}-${i}`}
              id={`tag-replace-option-${i}`}
              suggestion={option}
              index={i}
              active={i === activeIdx}
              assets={assets}
              onPick={onPick}
              onHover={setActiveIdx}
            />
          ))}
        </div>
      </motion.div>
    </div>
  );
}

function matchesImgQuery(n, q) {
  if (!q) return true;
  const canonical = `img${n}`;
  if (canonical.startsWith(q)) return true;
  if ("image".startsWith(q) || q.startsWith("image")) {
    const numPart = q.replace(/^image\s*[-_]?/, "");
    if (!numPart) return true;
    return String(n).startsWith(numPart);
  }
  if ("picture".startsWith(q) || q.startsWith("pic")) {
    const numPart = q.replace(/^(?:picture|pic)\s*[-_]?/, "");
    if (!numPart) return true;
    return String(n).startsWith(numPart);
  }
  return false;
}

function classifyMentionToken(raw) {
  // Canonical: @img1, @vid1, @audio1
  const canonicalMatch = raw.match(/^@(img|vid|audio)(\d+)$/i);
  if (canonicalMatch) {
    return {
      type: canonicalMatch[1].toLowerCase(),
      index: parseInt(canonicalMatch[2], 10),
      isCanonical: canonicalMatch[1].toLowerCase() !== "img" || /^[1-9]\d*$/.test(canonicalMatch[2]),
    };
  }

  // Informal: @image 1, @image1, @img 1, @video 1, @audio 1, etc.
  const informalImg =
    raw.match(/^@(image|pic)[\s_-]*(\d+)$/i) || raw.match(/^@img[\s_-]+(\d+)$/i);
  if (informalImg) {
    return {
      type: "img",
      index: parseInt(informalImg[2] || informalImg[1], 10),
      isCanonical: false,
    };
  }
  const informalVid =
    raw.match(/^@video[\s_-]*(\d+)$/i) || raw.match(/^@vid[\s_-]+(\d+)$/i);
  if (informalVid) {
    return {
      type: "vid",
      index: parseInt(informalVid[2] || informalVid[1], 10),
      isCanonical: false,
    };
  }
  const informalAudio = raw.match(/^@audio[\s_-]+(\d+)$/i);
  if (informalAudio) {
    return {
      type: "audio",
      index: parseInt(informalAudio[1], 10),
      isCanonical: false,
    };
  }

  // Slug: @sati, @scene1
  const slugMatch = raw.match(/^@([a-z][a-z0-9_-]*)$/i);
  if (slugMatch) {
    return {
      slug: slugMatch[1].toLowerCase(),
      isAsset: true,
    };
  }

  return null;
}

const HIGHLIGHT_TOKEN_REGEX =
  /@(?:image|pic|img|video|vid|audio)[\s_-]*\d+(?![a-z0-9_-])|@([a-z][a-z0-9_-]*)/gi;

/** Every highlighted @tag in `text` that starts a word (so "a@b.com" is not a tag), in order. */
export function mentionTokens(text) {
  const out = [];
  for (const m of text.matchAll(new RegExp(HIGHLIGHT_TOKEN_REGEX))) {
    if (m.index > 0 && /[a-z0-9_]/i.test(text[m.index - 1])) continue;
    out.push({ start: m.index, end: m.index + m[0].length, raw: m[0] });
  }
  return out;
}

/** Spellings of one reference ("@img2", "@IMG2", "@image 2") share a key. */
function tagKey(raw) {
  return normalizePromptMentions(raw).toLowerCase();
}

/**
 * Replaces the tag starting at `start` and every other spelling of the same tag with `tag`, the
 * way choosing a reference from Higgsfield's "Replace @x with" menu rewrites every chip of that
 * tag. `caret` sits right after the replacement of the tag at `start`. Null when no tag starts
 * there.
 */
export function replaceTagEverywhere(text, start, tag) {
  const tokens = mentionTokens(text);
  const target = tokens.find((t) => t.start === start);
  if (!target) return null;
  const key = tagKey(target.raw);
  let out = "";
  let last = 0;
  let caret = 0;
  for (const token of tokens) {
    if (tagKey(token.raw) !== key) continue;
    out += text.slice(last, token.start) + tag;
    last = token.end;
    if (token === target) caret = out.length;
  }
  return { text: out + text.slice(last), caret };
}

/** Split text into plain runs and @tag tokens; valid tags get a dusty light blue (#589edb) highlight,
 *  unknown ones go red, recognized non-canonical tags get an amber hint. */
function renderHighlighted(
  text,
  tagCount,
  assetSlugs,
  videoCount = 0,
  audioCount = 0
) {
  const out = [];
  const re = new RegExp(HIGHLIGHT_TOKEN_REGEX);
  let last = 0;
  let m;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const raw = m[0];
    const info = classifyMentionToken(raw);

    let isValid = false;
    let isInformal = false;

    if (info?.isCanonical) {
      if (info.type === "img") isValid = info.index >= 1 && info.index <= tagCount;
      else if (info.type === "vid") isValid = info.index >= 1 && info.index <= videoCount;
      else if (info.type === "audio") isValid = info.index >= 1 && info.index <= audioCount;
    } else if (info && !info.isAsset) {
      isInformal = true;
      if (info.type === "img") isValid = info.index >= 1 && info.index <= tagCount;
      else if (info.type === "vid") isValid = info.index >= 1 && info.index <= videoCount;
      else if (info.type === "audio") isValid = info.index >= 1 && info.index <= audioCount;
    } else if (info?.isAsset) {
      isValid = assetSlugs.has(info.slug);
    }

    const reservedImage = /^@(?:img|imgg|image|pic)(?:$|[\s\d_-])/i.test(raw);
    const imageWarning = reservedImage && (!isValid || isInformal || !info?.isCanonical);
    out.push(
      <span
        key={key++}
        data-mention-start={m.index}
        title={imageWarning ? "Literal image-reference text. Attach the exact numbered reference or use a valid @imgN tag; this warning does not block submission." : undefined}
        className={cn(
          "rounded-sm",
          imageWarning ? "bg-amber-500/20 text-amber-200 ring-1 ring-amber-400/40" : isValid
            ? isInformal
              ? "bg-amber-500/20 text-amber-200 ring-1 ring-amber-400/40"
              : "bg-mention/20 text-mention"
            : "bg-red-500/20 text-red-300"
        )}
      >
        {raw}
      </span>
    );
    last = m.index + raw.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Attached media share the same autocomplete and keyboard selection path. */
export function attachedMediaSuggestions(query, videoCount, audioCount) {
  const q = query.toLowerCase();
  const vids = Array.from({ length: videoCount }, (_, i) => i + 1)
    .filter((n) => {
      if (!q) return true;
      if (`vid${n}`.startsWith(q)) return true;
      if ("video".startsWith(q) || q.startsWith("video")) {
        const numPart = q.replace(/^video\s*[-_]?/, "");
        if (!numPart) return true;
        return String(n).startsWith(numPart);
      }
      return false;
    })
    .map((n) => ({
      tag: `@vid${n}`,
      label: `@vid${n}`,
      sub: "video ref · motion / camera",
    }));

  const audios = Array.from({ length: audioCount }, (_, i) => i + 1)
    .filter((n) => {
      if (!q) return true;
      if (`audio${n}`.startsWith(q)) return true;
      const numPart = q.replace(/^audio\s*[-_]?/, "");
      if (!numPart) return true;
      return String(n).startsWith(numPart);
    })
    .map((n) => ({
      tag: `@audio${n}`,
      label: `@audio${n}`,
      sub: "attached audio",
    }));

  return [...vids, ...audios];
}

