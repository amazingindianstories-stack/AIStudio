# Design: Precomputed Thumbnail + Blur-Placeholder Pipeline

Contract for the implementer and test-engineer. Build strictly from this
document; do not touch files outside the File plan without stating a reason.

## Overview

Today grid/feed/canvas thumbnails are produced on the hot request path by the
already-shipped `GET /api/media/[...path]?w=` resize (sharp → webp, metered
Vercel compute, poorly edge-cacheable because the route is session-gated). This
change moves thumbnail production to **write time**: when an image generation
succeeds, we generate once a small webp thumbnail (stored under a
`thumbnails/` key) plus a tiny inline base64 blur placeholder, persist both on
the `generations` row, and have the highest-traffic clients prefer the stored
thumbnail. The on-the-fly `?w=` route is **unchanged** and remains the fallback
for anything without a precomputed thumbnail (assets, canvas nodes,
not-yet-backfilled rows, thumbnail-step failures). The blur value drives a
blur-up cross-fade on the two card surfaces, removing the blank-then-pop flash.

This mirrors the existing `saveAvatarImage` resize-at-write pattern in
`save-media.ts` — no new dependency (sharp is installed), no new architecture.
It beats "improve the on-the-fly route" (e.g. cache harder) because the route
can't be edge-cached across sessions while auth-gated, so the compute cost is
structural; precomputing once removes it entirely for the common path.

**Rollout constraint (call out in the PR, not solvable in code):** the two new
columns are additive and nullable, but `itemToValues` will start writing them
on the very next generation. Running this code against Postgres **before**
`npm run db:push` produces a raw SQL error on every generation (missing
column). Ship on a feature branch; the user runs, in order: (1)
`npm run db:push`, (2) deploy, (3) optional `npx tsx
scripts/backfill-thumbnails.ts`. New generations after step 1 get thumbnails
automatically regardless of backfill.

## File plan

**Create**
- `src/lib/thumbnail.ts` — pure, storage-agnostic thumbnail+blur generator
  (`generateThumbnailAndBlur`). No storage/DB imports, so it is unit-testable
  without mocks. Holds the size/quality constants.
- `src/lib/thumbnail.test.ts` — `node:test`/`node:assert` unit test for the
  pure function (valid input → smaller webp + valid tiny blur data URL; corrupt
  input rejects).
- `src/components/BlurImage.tsx` — shared presentational blur-up `<img>` used by
  both card surfaces. Reason for a new shared component: MediaCard and
  ConversationPanel need identical load-state/blur-layer JSX; a shared component
  prevents the two surfaces from drifting (same rationale as
  `canvas/selection-actions.ts`) and keeps the blur contract in one place.
- `scripts/backfill-thumbnails.ts` — idempotent one-off backfill for existing
  rows.

**Modify**
- `src/lib/schema.ts` — add two nullable `text` columns to `generations`:
  `thumbnail_url`, `blur_data_url`.
- `src/lib/types.ts` — add `thumbnailUrl?: string` and `blurDataUrl?: string` to
  `GenerationItem`.
- `src/lib/store-db.ts` — map the two new fields in `rowToItem` and
  `itemToValues`, following the `poster` pattern exactly.
- `src/lib/save-media.ts` — add `saveGenerationThumbnail(input, id)`: the
  storage-aware wrapper that calls `generateThumbnailAndBlur`, uploads the
  thumbnail buffer under `thumbnails/<id>.webp`, and returns
  `{ thumbnailUrl, blurDataUrl }`.
- `src/app/api/queue/execute/route.ts` — after both branches converge on `url`
  and before `done` is built, best-effort produce `thumbnailUrl` + `blurDataUrl`
  and include them on `done`. Local try/catch; never affects success/failure of
  the parent item.
- `src/lib/utils.ts` — add `resolveThumb(thumbnailUrl, fallbackUrl, width)`
  precedence helper next to `thumbUrl`.
- `src/components/MediaCard.tsx` — image branch uses `BlurImage` +
  `resolveThumb`; video branch unchanged.
- `src/components/ConversationPanel.tsx` — image branch uses `BlurImage` +
  `resolveThumb`; video branch unchanged.
- `src/components/canvas/CanvasAssetPanel.tsx` — inside `AssetThumb`, the tile's
  own `<img src>` prefers `item.thumbnailUrl` via `resolveThumb`; the
  `onPlaceAtCenter({ url: src })` call is left on full-res `src`. No blur-up on
  the canvas panel (per spec, blur is card-surfaces only).

Explicitly **not touched** (per spec Non-goals): `src/app/api/media/[...path]/route.ts`,
`src/app/api/generate/video/status/route.ts`, `src/lib/canvas/*`, any canvas
node persistence, `next/image`, pricing/cost/best-of-N logic, asset
(`assets.images[]`) precompute, `MEDIA_BACKEND`/`DATABASE_BACKEND`.

## Interfaces

### `src/lib/thumbnail.ts` (pure — no storage/DB imports)

```ts
// Constants — mirror the on-the-fly route so the two code paths look identical.
export const THUMB_MAX_DIM = 480;      // longest side, px
export const THUMB_QUALITY = 75;       // webp quality (matches media route)
export const BLUR_MAX_DIM = 16;        // longest side of the LQIP, px
export const BLUR_QUALITY = 30;        // webp quality for the LQIP

export interface ThumbnailResult {
  /** Small webp thumbnail bytes, ready to upload. */
  thumbnailBuffer: Buffer;
  /** Tiny inline placeholder, e.g. "data:image/webp;base64,AAAA...". */
  blurDataUrl: string;
}

/**
 * Produce a <=480px-longest-side webp thumbnail and a ~16px base64 blur
 * placeholder from arbitrary image bytes. Throws on empty/corrupt/oversized
 * input (sharp `failOn: "error"`, `limitInputPixels`) — callers treat this as
 * best-effort and swallow the throw.
 */
export function generateThumbnailAndBlur(input: Buffer): Promise<ThumbnailResult>;
```

Implementation notes (binding):
- Thumbnail: `sharp(input, { failOn: "error", limitInputPixels: 40_000_000,
  sequentialRead: true }).rotate().resize(THUMB_MAX_DIM, THUMB_MAX_DIM, { fit:
  "inside", withoutEnlargement: true }).webp({ quality: THUMB_QUALITY })
  .toBuffer()`. `fit: "inside"` constrains the *longest* side to 480 while
  preserving aspect ratio (the on-the-fly route uses width-only; `inside` is the
  correct generalization for a stored variant of unknown orientation).
- Blur: same sharp options, `.resize(BLUR_MAX_DIM, BLUR_MAX_DIM, { fit:
  "inside" }).webp({ quality: BLUR_QUALITY }).toBuffer()`, then
  `` `data:image/webp;base64,${buf.toString("base64")}` ``.
- Reject on empty input up front (`if (!input.length) throw ...`) so the test
  and caller see a clean rejection rather than a sharp-internal error.

### `src/lib/save-media.ts` (storage-aware wrapper)

```ts
/**
 * Best-effort: generate + store a thumbnail and inline blur for a succeeded
 * image generation. Thumbnail stored at `thumbnails/<id>.webp`; the returned
 * thumbnailUrl is the same-origin public URL. Throws if generation or upload
 * fails — the caller (queue/execute) swallows it.
 */
export async function saveGenerationThumbnail(
  input: Buffer,
  id: string
): Promise<{ thumbnailUrl: string; blurDataUrl: string }>;
```

Implementation: `const { thumbnailBuffer, blurDataUrl } = await
generateThumbnailAndBlur(input); const thumbnailUrl = await
uploadBuffer(thumbnailBuffer, \`thumbnails/${id}.webp\`, "webp"); return {
thumbnailUrl, blurDataUrl };`. Add `uploadBuffer` — already imported — nothing
new to import beyond `generateThumbnailAndBlur` from `./thumbnail`.

### `src/lib/utils.ts`

```ts
/**
 * Precedence for a displayed thumbnail: a precomputed stored variant when
 * present, else the on-the-fly `?w=` resize of the fallback source. The stored
 * variant is returned as-is (already small + webp + immutably cached — do NOT
 * re-wrap it with thumbUrl, that would re-trigger on-the-fly resize).
 */
export function resolveThumb(
  thumbnailUrl: string | undefined,
  fallbackUrl: string | undefined,
  width: number
): string | undefined {
  return thumbnailUrl || thumbUrl(fallbackUrl, width);
}
```

### `src/components/BlurImage.tsx` (`"use client"`)

```ts
interface BlurImageProps {
  src: string | undefined;      // resolved thumbnail (stored or on-the-fly)
  blurDataUrl?: string;         // tiny LQIP; absent → no blur layer, plain img
  alt: string;
  className?: string;           // applied to the <img> (e.g. hover scale on cards)
  loading?: "lazy" | "eager";
  decoding?: "async" | "sync" | "auto";
}
export default function BlurImage(props: BlurImageProps): JSX.Element;
```

Component structure (implementation shape is binding; visual params —
blur radius, scale, fade duration/easing, double-flash avoidance — per
`ui-spec.md`):
- Renders a fragment of **two layers**, each `absolute inset-0`, meant to sit
  inside the caller's existing `relative` aspect-ratio wrapper (so **no layout
  shift** — the wrapper already reserves the box via `paddingBottom`).
- `const [loaded, setLoaded] = useState(false);` — mirrors the `ImageNode`
  load-state pattern.
- Layer 1 (blur, rendered only when `blurDataUrl` is present): a `<div
  aria-hidden>` with `style={{ backgroundImage: \`url(${blurDataUrl})\` }}`,
  `object-cover`-equivalent (`bg-cover bg-center`), CSS blur + slight scale per
  ui-spec, sits underneath the img.
- Layer 2: the `<img key={src} src={src} alt loading decoding onLoad={() =>
  setLoaded(true)} />` with `object-cover`, `transition-opacity duration-150`
  (or per ui-spec), `style={{ opacity: loaded ? 1 : 0 }}`, plus `className`.
  The blur layer stays underneath at full opacity; the sharp img fades in over
  it on load — this is what prevents the double-flash (never a blank frame,
  never blur→blank→sharp).
- When `blurDataUrl` is absent, behavior degrades to a plain fading `<img>`
  (still no blank pop; opacity 0→1 over the reserved box).

### `src/lib/schema.ts`

Add inside the `generations` table definition (nullable — no `.notNull()`):

```ts
thumbnailUrl: text("thumbnail_url"),
blurDataUrl: text("blur_data_url"),
```

### `src/lib/types.ts`

Add to `GenerationItem`, doc-commented like neighbors:

```ts
thumbnailUrl?: string; // precomputed small webp thumbnail (image only); falls back to on-the-fly ?w= resize
blurDataUrl?: string;  // tiny inline base64 blur placeholder (image only)
```

### `src/lib/store-db.ts`

`rowToItem`: add `thumbnailUrl: r.thumbnailUrl ?? undefined,` and `blurDataUrl:
r.blurDataUrl ?? undefined,`. `itemToValues`: add `thumbnailUrl:
item.thumbnailUrl ?? null,` and `blurDataUrl: item.blurDataUrl ?? null,`.

## Data flow (queue/execute hook point)

Both branches already converge on `url` (MCP: `saveFromUrl`; Gemini:
`saveBase64`) just before `done` is built at ~line 360. Insert the hook there —
a single unified block reading the just-saved bytes back from storage, so the
hook is not duplicated per branch.

```ts
// imports to add at top of route:
//   import { saveGenerationThumbnail } from "@/lib/save-media";
//   import { mediaKeyFromRef, readStoredBuffer } from "@/lib/storage";

// ...both branches have set `url` (a same-origin /api/media/... URL)...

let thumbnailUrl: string | undefined;
let blurDataUrl: string | undefined;
try {
  const key = mediaKeyFromRef(url);       // null if url isn't a stored ref
  if (key) {
    const bytes = await readStoredBuffer(key);   // no auth-proxy round trip
    ({ thumbnailUrl, blurDataUrl } = await saveGenerationThumbnail(bytes, id));
  }
} catch (e) {
  // Best-effort: item still succeeds with `url`. Client falls back to ?w=.
  console.warn(`[image] thumbnail generation failed for ${id}:`, e);
}

const done: GenerationItem = {
  ...base,
  status: "succeeded",
  url,
  thumbnailUrl,   // undefined when the hook was skipped or threw
  blurDataUrl,
  costCents,
  updatedAt: Date.now(),
};
await upsertItem(done);
return NextResponse.json(done);
```

Key properties:
- The hook is **inside the existing outer `try`** but has its **own inner
  try/catch**, so a thumbnail failure never reaches the outer `catch` that marks
  the item `failed`. The item succeeds with `url` set regardless.
- Reading via `mediaKeyFromRef` + `readStoredBuffer` reuses the bytes we just
  wrote, unified across both provider branches (rather than passing the Gemini
  `base64` through and separately re-fetching for MCP).
- Video generations do not flow through this file for real providers and are
  out of scope; no `kind` guard is needed here because this route only handles
  image generations, but the hook is naturally inert for anything where
  `mediaKeyFromRef` returns null.

## Backfill script (`scripts/backfill-thumbnails.ts`)

Shape (match `scripts/migrate-to-s3.ts` boilerplate):

```ts
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { and, eq, isNull, isNotNull } from "drizzle-orm";
import { getDb } from "../src/lib/db";
import { generations } from "../src/lib/schema";
import { saveGenerationThumbnail } from "../src/lib/save-media";
import { mediaKeyFromRef, readStoredBuffer } from "../src/lib/storage";

const CONCURRENCY = 4; // matches MAX_CONCURRENT_CANVAS_IMAGES

async function main() {
  const db = await getDb();
  const rows = await db.select({ id: generations.id, url: generations.url })
    .from(generations)
    .where(and(
      eq(generations.kind, "image"),
      eq(generations.status, "succeeded"),
      isNull(generations.thumbnailUrl),
      isNotNull(generations.url),
    ));
  console.log(`[backfill] ${rows.length} rows to process`);

  let ok = 0, skipped = 0, failed = 0, i = 0;
  async function worker() {
    while (i < rows.length) {
      const row = rows[i++];
      try {
        const key = mediaKeyFromRef(row.url!);
        if (!key) { skipped++; continue; }
        const bytes = await readStoredBuffer(key);
        const { thumbnailUrl, blurDataUrl } = await saveGenerationThumbnail(bytes, row.id);
        await db.update(generations)
          .set({ thumbnailUrl, blurDataUrl, updatedAt: Date.now() })
          .where(eq(generations.id, row.id));
        ok++;
      } catch (e) {
        failed++;
        console.warn(`[backfill] ${row.id} failed:`, (e as Error).message);
      }
      if ((ok + skipped + failed) % 25 === 0) {
        console.log(`[backfill] progress ${ok + skipped + failed}/${rows.length}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`[backfill] done: ok=${ok} skipped=${skipped} failed=${failed}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
```

Idempotent: the `thumbnailUrl IS NULL` predicate means re-runs skip
already-backfilled rows; per-row try/catch means one bad object never aborts the
run. `updatedAt: Date.now()` keeps the bigint-ms timestamp convention (do not
touch `createdAt`).

## Client-side precedence logic

One rule everywhere: `resolveThumb(item.thumbnailUrl, <fallbackSource>, WIDTH)`.
`thumbnailUrl` is only ever set for succeeded images, so video paths naturally
fall through to their existing `thumbUrl(item.poster, …)` and are left
unchanged.

| Call site | Const | Before | After |
|---|---|---|---|
| `MediaCard.tsx` image branch (line ~101) | `CARD_THUMB_WIDTH = 480` | `<img src={thumbUrl(item.url, CARD_THUMB_WIDTH)} … className="… group-hover:scale-[1.04]" />` | `<BlurImage src={resolveThumb(item.thumbnailUrl, item.url, CARD_THUMB_WIDTH)} blurDataUrl={item.blurDataUrl} alt={item.prompt} loading="lazy" className="… group-hover:scale-[1.04]" />` |
| `MediaCard.tsx` video branch (poster) | — | unchanged | unchanged |
| `ConversationPanel.tsx` image branch (line ~206) | `FEED_THUMB_WIDTH = 1200` | `<img src={thumbUrl(item.url, FEED_THUMB_WIDTH)} loading="lazy" decoding="async" … />` | `<BlurImage src={resolveThumb(item.thumbnailUrl, item.url, FEED_THUMB_WIDTH)} blurDataUrl={item.blurDataUrl} alt={item.prompt} loading="lazy" decoding="async" />` |
| `ConversationPanel.tsx` video branch (poster) | — | unchanged | unchanged |
| `CanvasAssetPanel.tsx` `AssetThumb` tile img (line ~299) | `PANEL_THUMB_WIDTH = 320` | `<img src={thumbUrl(src, PANEL_THUMB_WIDTH)} … />` | `<img src={resolveThumb(item.thumbnailUrl, src, PANEL_THUMB_WIDTH)} … />` (plain img, no BlurImage) |
| `CanvasAssetPanel.tsx` `onPlaceAtCenter({ url: src })` | — | unchanged | unchanged — canvas placement keeps full-res `src` |

Notes:
- `BlurImage` must be inserted **inside** the existing
  `<div style={{ paddingBottom: aspectToPadding(...) }} className="relative w-full">`
  wrapper on both card surfaces (that wrapper is the positioning + aspect-ratio
  context that guarantees no layout shift). The two `absolute inset-0` layers
  BlurImage renders replace the single `absolute inset-0` `<img>` that was there.
- `CanvasAssetPanel` gets the fallback preference but **no** blur layer (spec:
  blur is card-surfaces only). Its `src` is `item.kind === "video" ? item.poster
  ?? item.url : item.url`; passing that as the fallback keeps video tiles on
  their poster path and only images gain the stored thumbnail.

## Error-handling / failure-mode table

| Condition | Where handled | Behavior |
|---|---|---|
| `generateThumbnailAndBlur` throws (sharp: corrupt/empty/oversized bytes) | inner try/catch in queue/execute | Warn-logged; `thumbnailUrl`/`blurDataUrl` stay `undefined`; item still succeeds with `url`; client uses on-the-fly `?w=` fallback |
| `uploadBuffer` throws (storage write fails) | same inner try/catch | Same as above — no thumbnail persisted, fallback path used |
| `readStoredBuffer` throws (object not readable) | same inner try/catch | Same — hook aborts, item succeeds |
| `mediaKeyFromRef(url)` returns `null` (url isn't a stored ref) | `if (key)` guard | Hook skipped entirely; both fields `undefined`; fallback path |
| Row already has a thumbnail (backfill re-run) | `thumbnailUrl IS NULL` SQL predicate | Row not selected; no work, no re-upload |
| Client: `thumbnailUrl` absent on an item | `resolveThumb` | Returns `thumbUrl(fallbackUrl, width)` — existing behavior, byte-for-byte |
| Client: `blurDataUrl` absent | `BlurImage` blur layer conditional | No blur layer; plain fading `<img>`, no blank pop |
| Schema not pushed before deploy | (out of code) | `itemToValues` writes unknown columns → SQL error on every generation. Mitigated by the rollout sequence: `db:push` first. Flagged in Overview and PR instructions |

## Trade-offs / risks

- **Feed uses a 480px thumbnail where it previously requested 1200px.** The
  single stored variant is 480px longest side; `ConversationPanel`
  (`FEED_THUMB_WIDTH = 1200`) will display it slightly upscaled on large cards.
  Accepted per spec's explicit single-size assumption (480/q75). The feed is a
  scroll surface, not the full-screen viewer; opening an item
  (`setActiveId`) still uses full-res `item.url` (untouched). Alternative —
  storing two variants or a larger thumbnail — was rejected as gold-plating
  beyond the spec's stated defaults.
- **Extra work on the generation response path.** The hook adds a storage read +
  sharp resize (~100–400ms, worst case for a 4K NBP result) to the
  queue/execute response before `done` returns. Chosen for a *unified* hook
  across both provider branches over passing the Gemini `base64` through
  (saving one read) plus a separate MCP fetch. Bounded by best-effort semantics
  and sharp's speed; if this proves material, the safe follow-up is to pass the
  in-memory Gemini buffer directly and only re-read for the MCP branch — noted,
  not built. Risk is contained: any slowness or failure cannot fail the item.
- **`blurDataUrl` inflates row + API payload size.** ~16px webp base64 is a few
  hundred bytes to ~1KB per row, sent in every `/api/history` page. Acceptable
  for the perceived-load win and it avoids a network request per placeholder;
  `text` column, no indexing.
- **New shared `BlurImage` component** adds one file rather than inlining. Chosen
  to prevent the two card surfaces from drifting on the blur/fade contract
  (which `ui-spec.md` pins) and to keep a single edit point; the cost is one
  small client component.
- **Backfill reads every matching object through storage.** For a large history
  this is I/O-heavy but bounded to concurrency 4, continues past failures, and
  is a one-off the user runs manually off the hot path.

## Out of scope (do not build)

Video poster/frame extraction (no ffmpeg), `assets.images[]` precompute, canvas
node persistence changes, `MEDIA_BACKEND`/`DATABASE_BACKEND`/CDN/signed-URL
changes, `next/image`, pricing/best-of-N changes, and any modification to the
on-the-fly `/api/media` route or the video status route.

## Test contract (`src/lib/thumbnail.test.ts`)

`node:test` + `node:assert`, run via
`npx tsx --test src/lib/thumbnail.test.ts`. Generate inputs in-test with sharp
(no fixture files):

1. **Valid input → smaller webp + valid blur.** Build a source buffer, e.g.
   `await sharp({ create: { width: 1000, height: 800, channels: 3, background:
   { r: 120, g: 80, b: 40 } } }).png().toBuffer()`. Call
   `generateThumbnailAndBlur`. Assert: `thumbnailBuffer` is non-empty and
   shorter than the input; `await sharp(thumbnailBuffer).metadata()` reports
   `format === "webp"` and `max(width, height) <= 480`; `blurDataUrl` starts
   with `"data:image/webp;base64,"` and its decoded bytes have
   `max(width, height) <= 16`.
2. **Aspect ratio preserved.** For the 1000×800 input, assert the thumbnail
   metadata keeps a 5:4-ish ratio (width 480, height 384) — i.e. `fit: "inside"`
   did not distort.
3. **Corrupt / empty input fails closed.** `await assert.rejects(() =>
   generateThumbnailAndBlur(Buffer.alloc(0)))` and
   `assert.rejects(() => generateThumbnailAndBlur(Buffer.from("not an image")))`
   — confirming the function throws (caller swallows) rather than returning
   garbage.
