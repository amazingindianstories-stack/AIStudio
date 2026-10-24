# Library filters and creation-day sections

The library uses a single Filters dialog with staged changes. Show results applies
the set; Cancel, Escape and outside click discard its draft. Options are OR within
a facet and AND across facets, prompt search and the current navigation scope.
Applied chips remain visible below the toolbar, including during selection. Clear
filters preserves search, navigation and View preferences.

## Fields and meaning

Type, model, creation date and favourites come first, followed by requested
resolution, aspect ratio, video duration/render stage, creator and the less common
status/bitrate controls. Favourites are shared generation state, not private likes.
Final is an explicit non-draft video; a missing draft flag is not Final. Missing
resolution, duration, stage and bitrate have explicit Not recorded choices, shown
only when the source has such rows.

Resolution, duration and bitrate describe the saved generation settings. They do
not claim measured master metadata. Image and video resolutions have distinct
identities even when both use a 4K label. Filters never invoke providers or change,
recompress or rename media.

## Django read contract

`GET /api/history` retains its existing project/folder/kind/favourite/q behavior.
These additional parameters are accepted:

| Parameter | Values |
| --- | --- |
| `type` | Repeated `image`, `video`, `depth` |
| `model` | Repeated stable registry ID or historical stored model name |
| `resolution` | Repeated typed tokens, e.g. `image:4k`, `video:1080p`, `video:unknown` |
| `aspect` | Repeated recorded ratios |
| `durationBucket` | Repeated `short` (1-5s), `medium` (6-10s), `long` (>10s), `unknown` |
| `stage` | Repeated `draft`, `final`, `unknown`; video only |
| `creator` | Repeated user UUIDs or `unknown` (missing attribution) |
| `status` | Repeated `ready`, `creating` (queued/running), `failed` |
| `bitrate` | Repeated `high`, `standard`, `unknown`; video only |
| `createdFrom` | Inclusive UTC epoch milliseconds |
| `createdBefore` | Exclusive UTC epoch milliseconds |
| `sort` | `newest`, `oldest`, or `starred` in the Favourites source |

Lists are bounded to 50 values, scalar lengths are bounded, and invalid values
return 400. Known model aliases resolve through the existing Python registry.
Retired/unknown names remain queryable. New filtered or explicitly sorted queries
use versioned cursors tied to their predicate and source fingerprint. Changing a
query resets its cursor. Legacy unfiltered cursor/response semantics remain
compatible with the historical read contracts.

`GET /api/history?options=1` returns an option catalog for the same authorized
navigation source. It ignores prompt/metadata predicates, includes historical
models and values beyond the first page, and respects project, folder and the
inherited Favourites source. It returns types, model descriptions, typed
resolutions, aspects, creator IDs and `unrecorded`: the video fields
(`durationBucket`, `stage`, `bitrate`) missing on at least one video, which is
when Not recorded is offered. This is an option directory, not facet
counts. Existing `/api/history/counts` remains navigation totals; do not present
its numbers or loaded-page lengths as exact filtered totals.

The menu loads this directory on opening, supports retry, and cancels an obsolete
read on close/source change. Fixed facets remain useful when no directory values
exist. No extra schema fields or indexes are required by this change. Measure
scoped aggregation before introducing counts or speculative indexes.

## Client state and live updates

The wire mapping and row membership are in `src/lib/library-filters.js`, with
navigation and ordering in `src/lib/feed-scope.js`. Every predicate participates in
the feed cache key, API transport and incoming-row membership. Applying a set
clears old selection and resets paging. Query response sequencing still prevents
a late result from repainting a different scope. Once an applied set's first page
settles, a polite status announces no matches, an exact count when every match is
loaded, or that more load on scroll; navigation restores are not announced. The Filters
trigger is named with its active dimension count ("Filters, 2 active"). Cached rows retain their scope
so metadata mutations can remove rows that no longer match.

Search and filters are restored per actor and navigation source in this browser
tab's sessionStorage, bounded to recent sources. A new folder starts clean;
returning restores its query. Actor changes and logout clear the previous actor's
session metadata. Only predicate metadata is stored, never media/bearer URLs.
The library predicates do not narrow the chat thread or change its folder rules.

## Dates and masonry

Date presets use local calendar midnights converted to UTC, including DST. Last
7 days includes today and six previous dates. Custom Through is inclusive in the
UI and exclusive at the next midnight on the wire. Midnight, tab resume and a
timezone change refresh relative bounds and labels.

View controls thumbnail size, sort and creation-date grouping. Inline full-width
headers read Today, Yesterday, `20 Oct`, or `20 Oct 2025` outside the current year.
Each day uses its own existing greedy masonry pack. A paginated day continuation
has one header; appending preserves existing placements. All sections publish one
complete column map for viewer Up/Down, plus global card centers for spatial
Left/Right. Creation grouping is disabled for Recently starred because that sort
can interleave creation dates. The grouping preference is retained for a creation
sort. Exact day counts are deliberately omitted.

On phones, search takes its own row and search, Filters, View, chip removal and
Clear filters are 44px targets; the selection toolbar matches that row height.
The same form uses a native modal bottom sheet with a horizontally
scrolling category rail, scrolling options and a fixed action footer. Native
dialog modality isolates the background and traps focus; closing restores it to
Filters. Escape cancels this dialog before the parent assets drawer.

## Verification

Backend predicates, scope, pagination, cursor rejection and historical compatibility
are covered by `apps.generation.test_library_filters`, `apps.generation.tests` and
`testsupport.test_history_plans`, run only through `scripts/dev/test-db.sh`.
Frontend tests cover staged interaction, clear recovery, wire/live/cache parity,
DST bounds, append stability and navigation across dates. Real browser checks use
disposable local data and mock filesystem storage, never customer credentials or
live providers.
