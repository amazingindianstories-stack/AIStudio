# UI Spec: Blur-up (LQIP) thumbnail cross-fade

Visual/motion contract for the blur-placeholder → sharp-thumbnail cross-fade in
`MediaCard.tsx` and `ConversationPanel.tsx`. This owns **what the user sees and
feels**. Data flow, the `loaded` boolean, `onLoad`/`onError` wiring, and which URL
gets requested are the architect's `design.md` — where this spec says "on load"
or "on error" it means those handlers, however the architect chooses to plumb
them.

Reference pattern already in the codebase: `src/components/canvas/nodes/ImageNode.tsx`
(a `loaded` boolean, `onLoad`/`onError`, `style={{opacity: loaded ? 1 : 0}}`,
`transition-opacity duration-150`). This spec **deliberately deviates** from that
150 ms timing — see §2 for why.

---

## 0. Scope guard (read first)

- The blur-up treatment applies to **`kind: "image"`, `status: "succeeded"`
  items that have `item.blurDataUrl`**. That is the only case the pipeline
  produces a blur placeholder for (spec acceptance criterion 2 generates
  `blurDataUrl` on image success only).
- **Videos never get the blur treatment.** Real (non-mock) videos have no
  poster and no `blurDataUrl`; they keep today's exact rendering (native
  `<video>` / poster-only-in-mock). Do not synthesize a blur layer for them.
- `pending`, `failed` (i.e. `item.status !== "succeeded"`), and every overlay
  chrome element (favourite, download, creator, prompt gradient, delete,
  selection checkbox, kind chip) are **unchanged**. This spec only touches the
  media `<img>` and adds one placeholder layer behind it.
- **No layout shift, ever.** The existing `paddingBottom: aspectToPadding(...)`
  aspect box already reserves the media's height before anything loads; the
  blur layer and the `<img>` are both `absolute inset-0` inside it. Nothing in
  this spec changes box geometry.

---

## 1. The blur placeholder layer

### 1.1 What paints, and how

Add **one** decorative layer as the **first child inside the existing aspect box**
(`<div style={{paddingBottom: ...}}>`), rendered **only when
`item.blurDataUrl` is present**, positioned behind the media `<img>` by DOM
order (both are `absolute inset-0`; later siblings paint on top).

Paint the placeholder as a **CSS `background-image` on a `<div>`**, not as a
second `<img>`. Rationale:
- `blurDataUrl` is an inline base64 data URL — a background-image paints
  **instantly with zero network request and no decode-then-onLoad lifecycle**,
  which is exactly the "instant paint" the spec asks for.
- A `<div>` is cheaper than an `<img>` at grid scale (dozens of cards fading in
  at once): no element in the accessibility tree, no separate load event, no
  layout/paint cost beyond a single painted rectangle.

Exact layer:

```
aria-hidden
class:  pointer-events-none absolute inset-0
style:  backgroundImage: url(<item.blurDataUrl>)
        backgroundSize: cover
        backgroundPosition: center
        filter: blur(16px)
        transform: scale(1.1)
```

### 1.2 Why `blur(16px)` + `scale(1.1)` (blockiness handling)

The source is ~16 px on its longest side, upscaled to fill a 160–768 px box
(≈10–48× magnification). Browsers already smooth (bilinear) an upscaled
`background-image` by default, so it will **not** be hard-pixelated — but at that
magnification the smoothing alone still leaves soft blocky banding.

- **`filter: blur(16px)`** is what we rely on to fully hide the blockiness and
  give the classic LQIP "frosted" placeholder. One fixed radius across both
  surfaces (grid card and feed) keeps the look consistent; at the largest feed
  width it's marginally softer, which is fine and on-brand for a placeholder.
  Do **not** also set `image-rendering` — the default smoothing plus this blur
  is sufficient, and `image-rendering: pixelated` would fight the blur.
- **`transform: scale(1.1)`** compensates for the blur's soft, semi-transparent
  bleed at the box edges (a `blur()` filter samples past the painted content and
  produces a faded rim). Scaling the layer up 10 % pushes that rim outside the
  aspect box; the existing `overflow-hidden` on the card / feed container clips
  it. Without this you'd see a faint dark vignette ring around every placeholder.

### 1.3 The blur layer does not animate or unmount on load

Once the sharp `<img>` reaches `opacity: 1` it is `object-cover` and fully
opaque — it **completely occludes** the blur layer. Therefore:
- The blur layer is painted **once** and **never fades out** — no second
  animation, no reflow. Cheapest possible at scale.
- It may remain mounted behind the loaded image; it is invisible. (If the
  architect prefers to unmount it after load to reclaim memory, that's allowed
  and visually indistinguishable — but it must never unmount *before* the image
  is fully faded in, or the blur will disappear mid-transition.)

---

## 2. The cross-fade (sharp thumbnail fading in over the blur)

The media `<img>` starts transparent and fades to opaque on load, revealing over
the blur underneath.

| Property        | Value                                                        |
|-----------------|--------------------------------------------------------------|
| Animated prop   | `opacity` only                                               |
| From → To       | `0` → `1`                                                     |
| Trigger         | image `onLoad` (see §2.1 for the cache-hit requirement)      |
| Delay           | none — fade begins the instant load fires                    |
| Duration        | **300 ms**                                                   |
| Easing          | **ease-out** (decelerate; e.g. `cubic-bezier(0, 0, 0.2, 1)`) |

**Why 300 ms ease-out instead of ImageNode's `duration-150`:** ImageNode fades
in over a *spinner on a dark panel* (no real placeholder), where a fast 150 ms
fade just minimizes an empty gap. Here we fade in over a **meaningful blur of the
actual image**, so a slightly longer, decelerating cross-fade reads as an
intentional "pulling into focus" and better hides the seam between the two
resolutions. 300 ms is still fast enough to feel instant on a warm connection and
imperceptible on a cached hit. Ease-out lands the image gently rather than
snapping.

**Both surfaces use the same 300 ms ease-out opacity fade.** Consistency across
the grid and the feed is worth more than giving the feed a richer, one-off
motion.

### 2.1 Cache-hit must not stick at opacity 0

If the thumbnail is already in the browser cache, its load can complete before
the React handler is attached, and a naive `loaded` boolean would leave the image
stuck transparent forever (showing a permanently blurry card). **Requirement:** an
already-cached / already-complete thumbnail must appear at full opacity (it may
skip the fade entirely and just be `opacity: 1` immediately). The implementer must
account for the cache-hit case (e.g. initialize `loaded` from the img's
`complete` flag), not merely rely on a future `onLoad`. This is a visual
correctness requirement, not an optimization.

### 2.2 Interaction with the existing hover-zoom (MediaCard only)

MediaCard's `<img>` already carries `transition-transform duration-500` and
`group-hover:scale-[1.04]`. The new opacity fade must **not** clobber that.

- The `<img>` must transition **both** properties with their **own durations**:
  `opacity` at 300 ms ease-out (§2) **and** `transform` at the existing 500 ms
  (Tailwind default `ease`). Because these durations differ, they cannot both
  ride Tailwind's single `duration-500` shorthand — use longhand
  (`transition: opacity 300ms cubic-bezier(0,0,0.2,1), transform 500ms cubic-bezier(0.4,0,0.2,1)`
  via inline style or an arbitrary class). The hover-zoom feel is preserved
  exactly; only opacity is added.
- The blur layer (§1) must **not** scale on hover — it keeps its static
  `scale(1.1)` and is occluded once loaded, so the hover zoom is a property of
  the sharp image alone, exactly as today.
- Placing the blur `<div>` as an earlier sibling inside the same aspect box does
  not affect `group-hover` targeting: the `group` is the outer `motion.div`, and
  the `<img>` keeps its own classes. Confirmed non-breaking.

ConversationPanel's feed `<img>` has **no** hover transform today — there it
transitions `opacity` at 300 ms ease-out only. Do not add a zoom.

### 2.3 When `item.blurDataUrl` is absent (degraded path) — CONFIRMED

**Agreed with the recommendation: skip the blur-up entirely.** For a
`succeeded` image with **no** `blurDataUrl` (older, not-backfilled rows):

- Render **no** placeholder `<div>` (there is nothing to blur-up from).
- Render the `<img>` **exactly as today**: plain `loading="lazy"`,
  **no opacity gating, no fade** — it appears when the browser paints it, which
  is the pre-existing behavior. Do not fade in from transparent over a bare dark
  box; without a placeholder that's just a slower version of today's pop and buys
  nothing.

So the opacity/fade machinery (§2) is **conditional on `item.blurDataUrl` being
present**. No blur data ⇒ today's code path, untouched. This also cleanly covers
videos (§0) and any item the architect routes to the on-the-fly `?w=` fallback.

---

## 3. Thumbnail load failure (`onError` while `status === "succeeded"`)

This is a **new, narrow state**: the parent generation succeeded, but the
displayed thumbnail `<img>` itself failed to load (expired/missing variant,
transient network). It is distinct from `item.status === "failed"` (the red error
panel), which stays exactly as-is.

**Behavior on the thumbnail's `onError`:**

1. **Do not** fade the broken image in — it stays at `opacity: 0`, so the blur
   placeholder (§1) remains the resting visual. The blur is a real, if soft,
   representation of the image, so the card is not blank.
2. **Add a small, non-blocking affordance** so a permanently-soft card is not
   mistaken for "still loading": center an `ImageOff` glyph (lucide, matching
   `ImageNode`'s failed state), `h-5 w-5`, `text-white/25`, `aria-hidden`,
   `pointer-events-none`, over the blur. No spinner, no text, no red — this is a
   soft "full image unavailable here" hint, not an error.
3. The card stays **clickable** and all chrome stays functional — clicking still
   opens the full view (which loads `item.url` directly), so the user is never
   trapped by a thumbnail miss.

If `item.blurDataUrl` is **absent** and the thumbnail also errors, there is no
placeholder to fall back to: show the same `ImageOff` glyph centered on the plain
`bg-ink-750`/`bg-ink-800` box. (Whether the architect first retries against the
full-res `item.url` before surfacing this state is their call; visually, this is
the terminal appearance if nothing loads.)

The blur layer must **never stay visible with no affordance while an image is
known to have failed** — a bare indefinite blur reads as a stuck spinner and is
not acceptable.

---

## 4. Accessibility

- The blur placeholder `<div>` is decorative: `aria-hidden` and
  `pointer-events-none`. It carries no `role`, no `alt`.
- The sharp `<img>` keeps its existing `alt={item.prompt}`; the accessible name
  of the media is unchanged by this feature.
- The `ImageOff` failure glyph (§3) is decorative/`aria-hidden` — the failure is
  conveyed structurally by the still-present blur and the intact card, not
  announced. (This matches `ImageNode`, which also renders its failure icon
  decoratively.)
- **Reduced motion:** under `prefers-reduced-motion: reduce`, **drop the
  cross-fade** — the sharp thumbnail appears at `opacity: 1` on load with no
  opacity transition (the blur still paints instantly and is simply replaced).
  The hover-zoom transform is likewise already motion; honor the same query for
  it if the surrounding code does, but at minimum the newly-added opacity fade
  must be suppressed. No other behavior changes.
- **Contrast / no new text:** this feature introduces no new text and no new
  interactive control, so there is no new contrast surface to verify. The blur
  placeholder must not reduce the contrast of any overlay chrome that sits above
  it — all existing overlays already render above the media `<img>`, i.e. above
  the blur, so their contrast is unaffected.

---

## 5. Acceptance checklist (verifiable from the rendered UI)

A reviewer should be able to confirm each of these by watching a feed/grid load
(throttle the network to see the transition) and by forcing the error case:

1. **No blank-then-pop.** On a succeeded image with `blurDataUrl`, the card is
   never blank: a soft blurred version paints immediately, then the sharp image
   cross-fades in. Verifiable by throttling network and watching one card.
2. **No layout shift.** The card occupies its final height before, during, and
   after load (aspect box reserves space). Verifiable by eye / layout-shift
   tooling — zero CLS from this feature.
3. **Cross-fade is a fade, ~300 ms, decelerating.** The sharp image eases in over
   the blur; it does not hard-cut and does not slide/scale in.
4. **Blur has no hard pixels and no dark edge ring.** The placeholder looks
   frosted/soft edge-to-edge, with no vignette rim and no blocky squares.
5. **Hover-zoom still works (MediaCard).** Hovering a loaded card still scales the
   image to 1.04 over ~500 ms; the fade did not break it.
6. **Cache hit is instant.** Scrolling a card out and back (thumbnail cached)
   shows the sharp image immediately at full opacity — never stuck blurry/blank.
7. **Thumbnail error state is legible.** With a succeeded item whose thumbnail
   404s, the card shows the blur + a small `ImageOff` glyph, stays clickable,
   and is clearly not the red `failed` panel.
8. **Degraded rows look like today.** A succeeded image with no `blurDataUrl`
   renders exactly as the current build (no placeholder, no fade), with no
   regression.
9. **Both surfaces match.** The grid card and the feed image use the same blur +
   300 ms ease-out fade; they feel like one treatment, not two.
10. **Reduced motion.** With `prefers-reduced-motion: reduce`, the sharp image
    appears without an animated fade.

---

## Assumptions logged (spec was directional on visuals)

- **Blur radius 16 px and layer `scale(1.1)`** are my picks to guarantee no
  blockiness / no edge rim from a ~16 px source across a 160–768 px box; if the
  implementer sees residual pixelation at the largest feed width, the radius may
  be raised (up to ~24 px) but must stay identical between the two surfaces.
- **300 ms ease-out** cross-fade (vs. ImageNode's 150 ms) is a deliberate,
  justified deviation (§2) for the with-placeholder case; keep it uniform.
- **Failure affordance = `ImageOff` glyph over the retained blur** (not an
  indefinite bare blur, not a red panel) — chosen for consistency with
  `ImageNode` and to keep this narrow case visually distinct from
  `status === "failed"`.
