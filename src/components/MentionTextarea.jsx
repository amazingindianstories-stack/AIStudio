import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  forwardRef,

} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { TAG_REGEX, isImgTag, isVidTag } from "@/lib/mentions";
import { cn } from "@/lib/utils";

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
      videoRefs = [],
      assets = [],
      placeholder,
      className,
      maxLength,
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
    const assetSlugs = new Set(assets.map((a) => a.slug));

    // Unified suggestion list: ad-hoc uploads (@imgN) + named assets (@slug).
    const q = query.toLowerCase();
    const imgSuggestions = Array.from(
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
    const assetSuggestions = assets
      .filter((a) => a.slug.startsWith(q) || a.name.toLowerCase().includes(q))
      .map((a) => ({
        tag: `@${a.slug}`,
        label: `@${a.slug}`,
        sub: `${a.name} · ${a.kind}`,
        thumb: a.thumb,
      }));
    // Attached clips get their own tags. These were missing entirely, so typing
    // @vid1 offered nothing and highlighted red — the tag existed only in the
    // provider layer, with nothing on this side producing or validating it.
    const vidSuggestions = Array.from(
      { length: videoRefs.length },
      (_, i) => i + 1
    )
      .filter((n) => `vid${n}`.startsWith(q))
      .map((n) => ({
        tag: `@vid${n}`,
        label: `@vid${n}`,
        sub: "attached clip",
      }));
    const available = [
      ...assetSuggestions,
      ...imgSuggestions,
      ...vidSuggestions,
    ];

    // Keeps the keyboard-selected suggestion visible: the list scrolls
    // (max-h-64 overflow-y-auto) once it has more entries than fit, and
    // without this ArrowDown/ArrowUp could move activeIdx past the visible
    // window with no visual sign anything happened.
    const menuRef = useRef(null);
    useEffect(() => {
      if (!menuOpen) return;
      menuRef.current
        ?.querySelector(`[data-suggestion-idx="${activeIdx}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }, [activeIdx, menuOpen]);

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

    const hasSuggestions = tagCount > 0 || assets.length > 0;

    const detectMention = (text, caret) => {
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

    const handleChange = (e) => {
      const v = e.target.value;
      onChange(v);
      detectMention(v, e.target.selectionStart);
    };

    const selectTag = (tag) => {
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
      <div className="relative min-w-0 flex-1">
        {/* highlight overlay (paint-only; background/color don't shift layout) */}
        <div
          ref={highlightRef}
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 max-h-[180px] overflow-hidden text-white/90",
            TYPO,
            className
          )}
          style={SYNCED_TEXT_STYLE}
        >
          {renderHighlighted(value, tagCount, assetSlugs, videoRefs.length)}
          {"\n"}
        </div>

        <textarea
          ref={taRef}
          value={value}
          onChange={handleChange}
          onKeyDown={onKeyDown}
          onScroll={syncScroll}
          onClick={(e) => detectMention(value, e.currentTarget.selectionStart)}
          onKeyUp={(e) => {
            if (suppressNextKeyUp.current) {
              suppressNextKeyUp.current = false;
              return;
            }
            detectMention(value, e.currentTarget.selectionStart);
          }}
          onBlur={() => setTimeout(() => setMenuOpen(false), 120)}
          rows={2}
          placeholder={placeholder}
          className={cn(
            // Deliberately NOT scroll-thin: a visible scrollbar (any width)
            // narrows this element's text-wrapping width relative to the
            // overlay div above, which never shows one — see TYPO's comment.
            "relative max-h-[180px] min-h-[58px] w-full resize-none bg-transparent text-transparent caret-white outline-none placeholder:text-white/35",
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
        <AnimatePresence>
          {menuOpen && available.length > 0 && (
            <motion.div
              ref={menuRef}
              role="listbox"
              initial={{ opacity: 0, y: 6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.97 }}
              transition={{ type: "spring", stiffness: 480, damping: 32 }}
              className="scroll-thin absolute bottom-[calc(100%+8px)] right-0 z-50 max-h-64 w-[min(16rem,calc(100vw-1rem))] overflow-y-auto rounded-xl border border-line bg-ink-750/95 p-1.5 shadow-pop backdrop-blur-xl"
            >
              <p className="px-2 py-1 text-[10px] uppercase tracking-wide text-white/35">
                Reference asset
              </p>
              {available.map((sug, i) => (
                <button
                  key={sug.tag}
                  role="option"
                  aria-selected={i === activeIdx}
                  data-suggestion-idx={i}
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
  text,
  tagCount,
  assetSlugs,
  videoCount = 0
) {
  const out = [];
  const re = new RegExp(TAG_REGEX);
  let last = 0;
  let m;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const slug = m[1].toLowerCase();
    const n = parseInt(slug.slice(3), 10);
    const valid = isImgTag(slug)
      ? n >= 1 && n <= tagCount
      : isVidTag(slug)
      ? n >= 1 && n <= videoCount
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
