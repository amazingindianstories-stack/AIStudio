# UI Spec: Admin "Status" tab

Binding visual contract for the new **Status** tab in `src/components/AdminDashboard.tsx`.
Covers visuals/interaction only; the data/API shape lives in the architect's design.md. Every
requirement below is checkable from a rendered screenshot or by clicking through the tab.

This tab must read as a fifth sibling of the existing Overview/Users/Logs/Pricing tabs — same
tokens, same table chrome, same badge/spinner/notice patterns. No new visual language.

## 0. Flagged assumptions (design gate — read these)

- **A-UI-1 — Atomic response, not streamed.** Recon confirms `/api/admin/status` returns a single
  JSON payload after `Promise.allSettled` of all six checks (not SSE/streaming). So from the
  client, all six rows resolve at the same instant. **Therefore this spec does NOT use per-row
  live spinners during refresh** (they would flip on/off in unison, adding complexity while
  implying a per-row truth the API can't deliver). Instead: keep previous results visible and
  dim the whole table while the single request is in flight (§4). If the API is ever changed to
  stream per-check, revisit this. On **first load only** (no previous results) each row shows an
  individual "Checking…" placeholder, because the six dependency names are static and known
  up front (§5).
- **A-UI-2 — Target viewport.** Internal admin tool. Designed for desktop ≥1024px (primary),
  must remain usable down to **360px** wide via the stacked-card fallback (§7). Matches the rest
  of `AdminDashboard` (`max-w-6xl` container, `sm:` breakpoint dual-render in `UsersTab`).
- **A-UI-3 — Three-state model.** `OK` (emerald), `Error` (red), `Unknown` (amber). "Unknown"
  is the single bucket for both "not configured" and "cached token expired / can't verify without
  cost" (spec acceptance criterion 8). It is visually distinct from both OK and Error and never
  reads as a failure.

## 1. Entry point (tab bar)

- Add `"status"` to the `Tab` union (currently `"overview" | "users" | "logs" | "pricing"`).
- Add one entry to the tab array (`AdminDashboard.tsx` ~line 162), placed **last**, after Pricing:
  `["status", "Status", Activity]`. Order in the bar: Overview · Users · Logs · Pricing · Status.
- **Icon:** `Activity` from `lucide-react` (the pulse/heartbeat line). No lucide `Activity` is
  imported today; add it to the existing lucide import block. It is the conventional health/status
  glyph and matches the outline weight of the other tab icons (`LayoutDashboard`, `ScrollText`,
  `DollarSign`). Rendered exactly like siblings: `<Icon className="h-4 w-4 shrink-0" />`, label in
  `<span className="hidden min-[420px]:inline">Status</span>`.
- Active/inactive styling is inherited verbatim from the existing `.map` — no overrides. Active =
  `bg-ink-650 text-white`; inactive = `text-white/55 hover:text-white`. `aria-pressed`, `aria-label`,
  and `title` come free from the shared button.
- **Render dispatch:** the Status tab must render its own content and MUST NOT be blocked by the
  global `!data ? "Loading…"` gate (that gate is for the `/api/admin/data` blob, which Status does
  not consume). Selecting Status while `data` is still loading shows the Status tab's own first-load
  state (§5), not the page-level "Loading…". Implement as a dedicated branch that renders
  `<StatusTab />` regardless of `data`.

## 2. Layout

`StatusTab` is a self-contained component (its own `load()` + `useEffect` on mount, fetching
`/api/admin/status`, exactly like `AdminDashboard` itself does for `/api/admin/data`). It receives
no `data`/`reload` props.

Vertical structure, top to bottom, inside a `<div className="space-y-3">` (matches `UsersTab`/`LogsTab`):

1. **Toolbar row** — `flex min-h-9 flex-wrap items-center justify-between gap-2`:
   - Left: **summary line** (§6, an `aria-live` status region), e.g. `Last checked 3:14:02 PM · 5 OK · 1 error`.
   - Right: **Refresh button** (§3), pushed right with `ml-auto` if it wraps.
2. **Top-level error notice** (only on whole-request failure, §5) — an `AdminNoticeLine`-style
   line directly under the toolbar.
3. **Results table** (desktop, `hidden sm:block`) / **card list** (mobile, `sm:hidden`).

**Table vs. cards — decision: TABLE on desktop, stacked CARDS on mobile.** Justification: the
dashboard reserves `Stat`/`Panel` cards for dashboard metrics/charts and uses **tables for every
list of rows with parallel columns** (Users, Logs, Activity, Pricing). Six dependencies × four
uniform attributes (name / status / detail / last-checked) is a list, not a set of metrics, so it
belongs in a table for scannability and column alignment. This also lets the status column align
into a single vertical band the admin can eyeball. Mobile falls back to the same
`sm:hidden` card / `hidden sm:block` table dual-render that `UsersTab` already uses (lines 603–731),
so the pattern is not new.

**Desktop table** — reuse the exact chrome from `PricingTab`/`LogsTab`:

```
<div className="scroll-thin hidden overflow-x-auto rounded-xl border border-line sm:block">
  <table className="w-full min-w-[640px] text-sm">
    <thead className="bg-ink-800 text-left text-xs uppercase tracking-wide text-white/40">
      <tr>
        <th className="px-3 py-2">Dependency</th>
        <th className="px-3 py-2">Status</th>
        <th className="px-3 py-2">Detail</th>
        <th className="px-3 py-2">Last checked</th>
      </tr>
    </thead>
    <tbody> …one <tr className="border-t border-line align-top"> per dependency… </tbody>
  </table>
</div>
```

- `min-w-[640px]` inside `overflow-x-auto` mirrors `UsersTab`'s `min-w-[760px]` scroll pattern
  (fewer/narrower columns here justify 640 vs 760). Below 640px the table scrolls horizontally on
  the rare desktop-narrow case, but the mobile card list is the real small-screen path.

**Rows are always exactly six, in this fixed order and with these exact display names:**

1. `Gemini / Nano Banana Pro`
2. `Higgsfield MCP`
3. `BytePlus ModelArk / Seedance`
4. `Gemini Omni Flash`
5. `Postgres`
6. `S3 Media Storage`

(Updated post-ship, Stage 3 review M1: these now match design.md §4's registry
`name` strings verbatim, since the frontend renders `CheckResult.name` directly
from the API rather than a separately hardcoded list — see decisions.md D5.)

Generation providers first (1–4), infrastructure last (5–6). Order never changes between renders,
so the status column is stable to scan. The name cell is plain text: `px-3 py-2 font-medium`
(matches Pricing's model cell). No per-dependency product logos/icons — that would introduce a
new pattern; the text name is the identifier, consistent with Pricing.

## 3. Refresh control

- Single button, top-right of the toolbar. Style is copied verbatim from the Logs "CSV" button —
  the dashboard's established secondary/utility button:
  `flex items-center gap-1.5 rounded-lg border border-line bg-ink-700 px-3 py-1.5 text-sm text-white/80 hover:text-white`.
  Add focus ring to match the icon-buttons: `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30`.
- **At rest:** `<RefreshCw className="h-4 w-4" /> Refresh`. Add `RefreshCw` to the lucide import
  (not imported today; it is the standard refresh glyph).
- **In flight:** swap the icon to `<Loader2 className="h-4 w-4 animate-spin" />` and the label to
  `Checking…`; add `disabled` with `disabled:opacity-40`. This exactly matches the dashboard's
  universal busy-button convention (`Create`, `Reset password`, `Seed` all swap to spinning
  `Loader2` while busy). Do **not** use a separate global overlay spinner.
- Disabled whenever a request is in flight; re-enabled on completion (success or error).

## 4. In-flight behavior (refresh with previous results present)

- **Preserve the previous results** — never blank the table to a full-page spinner. Checks are
  cheap/fast (~≤5s worst case, most sub-second), so blanking would flash and lose the admin's
  place. Instead:
  - The table (or card list) container gets `opacity-50 transition-opacity` and
    `pointer-events-none` while the request is in flight; previous badges/detail/timestamps stay
    readable-but-clearly-stale beneath the dim.
  - The Refresh button shows its busy state (§3).
  - The summary line (§6) stays showing the previous "Last checked …" until new results land, then
    updates.
- Per §A-UI-1, no per-row spinners here (atomic API → all rows would toggle together). The dim +
  busy button is the honest, single signal that a refresh is running.
- On completion, remove the dim; rows update in place (no layout shift — same six rows, same order).

## 5. Empty / first-load and error states

**First load (mount, no results yet).** Render all six rows immediately (names are static), each
with a per-row pending placeholder — this beats a blank spinner because it tells the admin exactly
what is being checked:

- Dependency cell: the name, at full opacity.
- Status cell: `<Loader2 className="h-4 w-4 animate-spin text-white/40" />` + `Checking…` in
  `text-xs text-white/40`.
- Detail cell: `—` (`text-white/30`).
- Last-checked cell: `—` (`text-white/30`).

The Refresh button is in its busy state during this first load too.

**Loaded (normal).** Each row shows the status badge (§6), detail (§below), and last-checked time.

**Whole-request failure** (route returns non-200, or `fetch` throws — network down, 403, 500):

- Show a top-level error notice under the toolbar, using the `AdminNoticeLine` error styling
  (`flex items-center gap-1.5 text-xs text-red-300` + an `AlertCircle`/`CheckCircle2`-style leading
  icon), text e.g. `Couldn't run status checks — HTTP 500`. Uses `role="status" aria-live="polite"`.
- If previous results exist, keep them visible (undimmed, not stale-marked beyond their existing
  timestamps) so the admin still sees the last-known state; the notice explains the refresh failed.
- If no previous results exist (failure on first load), leave the six rows rendered with Status =
  `Unknown` badge (amber) and Detail = `check failed`, so the page still shows all six dependencies
  rather than an empty void, and does not crash (acceptance criterion 9).
- Refresh remains enabled to retry.

**Per-dependency failure** is NOT a page error — it is just that row's `Error` (or `Unknown`)
badge. One failing check never blanks or crashes the others (criterion 9). This is guaranteed by
the atomic payload carrying an independent result object per dependency.

## 6. Status badge, detail, timestamp, and summary

**Status badge** (the Status cell). Reuse the shape of `UsersTab`'s Active/Disabled pill exactly:
`inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium`, plus a leading lucide icon,
plus a visible text label. **Color is never the only signal — every badge pairs a distinct icon
AND a distinct word:**

| State     | Text label      | Icon (lucide)   | Classes                              |
|-----------|-----------------|-----------------|--------------------------------------|
| OK        | `OK`            | `CheckCircle2`  | `bg-emerald-500/15 text-emerald-300` |
| Error     | `Error`         | `AlertCircle`   | `bg-red-500/15 text-red-300`         |
| Unknown   | `Unknown`       | `AlertTriangle` | `bg-amber-400/15 text-amber-300`     |

- Icons at `h-3.5 w-3.5`. `CheckCircle2` and `AlertCircle` are already imported/used in the codebase
  for success/error; `AlertTriangle` is already used elsewhere (amber, `CanvasView.tsx`) for the
  caution/attention meaning — the perfect neutral third state that is neither pass nor fail. Add
  `AlertCircle`/`AlertTriangle` to this file's lucide import as needed.
- The emerald/red/amber `/15` tint + `-300` text mirrors existing dashboard usage
  (`bg-emerald-500/15 text-emerald-300` on the Users badge; `bg-amber-400/15 text-amber-300` in
  `DetailModal`), so it needs zero new tokens.

**Detail string** (the Detail cell). One line, truncated, with full text on hover:
`max-w-[280px] truncate px-3 py-2 text-xs text-white/60` (identical to the Logs prompt / Activity
detail cells) plus a `title={detail}` attribute so the admin can read a long/technical error string
(e.g. a stack-y provider message or `HeadBucket 403 AccessDenied`) on hover. Because `truncate` is
CSS-only, the full string stays in the DOM and is fully available to screen readers and text
selection. Short config messages (`not configured`, `no cached token — needs refresh`) render
in full. Empty/absent detail renders `—` in `text-white/30`. Do **not** add an expand/accordion —
`title` + selectable full-DOM text is the established, lower-complexity dashboard pattern.

**Last checked** (the Last-checked cell). `whitespace-nowrap px-3 py-2 text-xs text-white/55`
(matches Logs time cell), value `new Date(checkedAt).toLocaleTimeString()`. Per-row because each
result may carry its own timestamp; on a normal refresh they will read identically, which is fine.
`—` (`text-white/30`) before first result.

**Summary line** (toolbar left). `role="status" aria-live="polite"`, `text-xs text-white/40`.
Format: `Last checked {toLocaleTimeString} · {n} OK · {m} error[s] · {k} unknown` — omit any bucket
whose count is 0 except always show at least the OK count. Before first result: `Running checks…`.
This is the accessible announcement channel for refresh completion (§8).

## 7. Responsive behavior

- **≥ sm (640px+):** desktop table (`hidden sm:block`), horizontal scroll below 640px content width
  via `overflow-x-auto` + `min-w-[640px]`.
- **< sm:** the table is hidden; render a **stacked card list** (`sm:hidden space-y-2`), one card per
  dependency, mirroring `UsersTab`'s mobile cards:
  - Card: `rounded-xl border border-line bg-ink-800 p-3`.
  - Top row (`flex min-w-0 items-center gap-3`): dependency name (`truncate text-sm font-medium`)
    on the left; status badge on the right (`ml-auto shrink-0`).
  - Divider + second row (`mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3`):
    detail (`min-w-0 flex-1 truncate text-xs text-white/60` + `title`) and last-checked time
    (`shrink-0 text-xs text-white/45`).
- Toolbar (`flex-wrap`): at narrow widths the Refresh button wraps under the summary line; it stays
  full-width-agnostic (never stretched), aligned via `ml-auto`.
- Designed to hold from 360px up to the `max-w-6xl` container. No horizontal page scroll on mobile;
  only the in-table scroll region (desktop) may scroll.

## 8. Accessibility

- **Not color-alone:** every status is conveyed by icon + word + color together (§6 table). A
  monochrome screenshot still distinguishes OK/Error/Unknown by both the glyph shape and the label
  text.
- **Refresh button:** native `<button type="button">` with visible `Refresh` label (its own
  accessible name; no `aria-label` needed). Keyboard: reachable in tab order, activated by
  Enter/Space, visible focus ring (`focus-visible:ring-2 focus-visible:ring-white/30`). While busy
  it is `disabled` (removed from tab order, which is acceptable — the whole table is inert during
  the short in-flight window). Label changes to `Checking…` so the state change is announced to AT
  when focus is on it.
- **Live announcements:** the summary line is `role="status" aria-live="polite"` so completing a
  refresh announces the new tally (e.g. "Last checked 3:14:02 PM · 5 OK · 1 error"). The top-level
  error notice is likewise `aria-live="polite"`. Do not put `aria-live` on the whole table (would
  spam the entire grid on every refresh).
- **Table semantics:** a real `<table>` with `<thead>`/`<th>` column headers (as spec'd), so screen
  readers announce "Dependency / Status / Detail / Last checked" per cell. On mobile the card list
  keeps name → status → detail order so linear reading is coherent.
- **Keyboard path through the feature:** Tab into the tab bar → arrow/Tab to the "Status" tab →
  Enter selects → Tab moves to the Refresh button → Enter runs a check → focus stays on Refresh;
  results update in place and are announced via the live region. No focus trap, no modal.
- **Contrast:** keep status text at the `-300` shade (emerald-300 `#6ee7b7`, red-300 `#fca5a5`,
  amber-300 `#fcd34d`) on the `ink-800`/`ink-900` backgrounds — all clear AA for the 12–13px text.
  Muted helper text stays at `white/40` or lighter-on-value (`white/55`+) minimum; do not drop the
  detail/timestamp text below `white/55` for primary information or `white/40` for the summary.

## 9. Out of scope (do not add)

- No auto-poll/interval, no historical/uptime graph, no per-row expand/detail modal, no toast, no
  per-dependency icons/logos, no drag/reorder. Manual refresh + the six static rows only.
