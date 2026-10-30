# Cards and work-tracking widgets: implementation baseline

Audited 2026-10-30 at `6860144`. Source: research checklist lines 214-233
and its adjacent `veevee-board-inventory.md`. All 16 selected items are NOW;
custom widgets (line 232) are unticked and excluded. The inventory predates
the two work-widget commits and is grounding, not current delivery evidence.

`Pending verification` is deliberately not a terminal outcome. It means code
exists, but this audit has not established full delivery. Only built, already
delivered, or skipped with a reason can satisfy the loop's stop condition.
No feature is skipped or needs a product decision at this point.

| Line | Feature | Size | Outcome | Evidence and remaining acceptance work |
| --- | --- | --- | --- | --- |
| 216 | Cards | M | Built | `WorkTools` implements structured fields, existing-user assignees, D and Cmd/Ctrl+Shift+Enter; `WorkNode` renders cards. Existing browser spec covers details and reload. Browser verified D creation, Ctrl+Shift+Enter details, all fields and reload persistence in iteration 3. Iteration 4 verified viewer/commenter inspection, disabled fields, blocked D creation, no browser board saves, and direct API save rejection (403), with unchanged persisted data. Iteration 5 verified Meta/Cmd details and editing through the widget selector after the card DOM node is culled, with API persistence and reload acceptance. Cards acceptance is complete. |
| 217 | Columns | M | Pending verification | `work-records.layoutColumns` uses board data; `WorkTools` adds, renames, recolors and moves lanes upward. Iteration 6 browser verified adding, renaming, recoloring and reordering columns and swimlanes, selecting both for a child card, saved cell geometry/containment and reload persistence. Iteration 7 browser verified viewer/commenter inspection of widget title, every lane/swimlane name and color, disabled reordering/add/arrange controls and child placement selectors, no browser writes and API save rejection. Remaining: reorder with existing children and offscreen operations. |
| 218 | Tables | XL | Pending verification | Django `WorkTable`/`WorkRecord` and `work_tables` own data; board widgets hold dataset IDs. `WorkDataPanel` has fields, card/sticky copying, CSV/Excel and owner-only editing. Verify schema migrations, indexed queries, roles and file round trips. |
| 219 | Filter, sort, search, grouping | M | Pending completion | SQL search/filter/sort and SQL group counts exist. Panel never sends `groupBy`; rendering groups only its current page. Complete grouping across pagination and add browser coverage. |
| 220 | Formulas and calculations | L | Pending verification | `work_formulas` uses an AST allowlist and SQL expressions; `work_tables.query` computes sums/averages across the query. Verify invalid expressions, nulls, numeric sorting and UI flows. |
| 221 | Relations and hierarchy | L | Pending completion | Parent IDs and dependency rows have server validation; detail panel selects links from current page only. Verify nesting semantics and make off-page relation targets available. |
| 222 | Notifications | M | Pending verification | Generic notification models, per-user preferences, viewer checks, polling inbox and scheduler reminders exist. Changes target assignee and table owner. Verify permissions, idempotency, preferences and scheduler delivery with disposable PostgreSQL. In-app only. |
| 223 | History | M | Pending verification | API writes before/after history and panel reads it. Load-earlier button is shown only at exactly 100 loaded rows, so verify pagination beyond two pages and actor/read permissions. |
| 224 | Visual numbers | S | Pending verification | `numberPresentation` and field settings support currency, percent, progress and thresholds; unit coverage exists. Verify empty values, formatting controls, conditional colors and persistence in browser. |
| 225 | Kanban view | L | Pending completion | Shared records, drag reclassification, hidden columns, swimlanes and view switching exist. Renderer only receives current page; establish complete-board behavior above 200 records. |
| 226 | Timeline | L | Pending completion | Date bars, drag/resize, milestones and dependency paths exist. `timelineLayout` ignores grouping and only marks nesting with an arrow in the label; complete grouping/nesting and pagination behavior. |
| 227 | Timeline Builder | S | Pending verification | `TimelineBuilder` and `buildTimeline` generate frames and labeled shapes from dates, interval, swimlanes and color; unit coverage round-trips serialization. Add browser generation, reload and role coverage. |
| 228 | User story mapping | M | Pending completion | Activity/release grouping exists; task field is created but does not participate in layout. Keyboard creation uses generic parent/sibling logic rather than activity/task/story/release context. Complete those semantics. |
| 229 | Mind map | L | Pending completion | Tree layout, collapse, colors, node styles and export exist; generated board output uses native shapes/connectors. Panel uses current page, so parents/descendants can disappear across pages. Verify keyboard focus and complete full-tree loading. |
| 230 | Org chart | L | Pending completion | Role/team fields, branch layout, hidden fields and stable-ID CSV import/export exist. Rendering uses current page; verify re-import hierarchy, clear-parent behavior, full-tree loading and import failures. |
| 231 | Charts | M | Pending completion | Shared numeric records drive SVG bar/line/pie and legend; table title is editable. Only current page is charted; define and implement complete-query data loading, then verify editing and reload. |

## Verification baseline

- Permanent browser coverage: `tests/browser/board-work.spec.mjs` currently has
  one cards/columns persistence test; it does not cover data-backed widgets.
- Backend coverage lives in `backend/apps/canvas/test_work_tables.py`.
- Pure layout, serialization and spreadsheet tests live in
  `src/lib/canvas/work-layouts.test.js` and `work-records.test.js`.
- This iteration is a source audit and outcome ledger, not live acceptance.
  No backend, browser suite, Docker stack or server was started.
- `npm run lint`: passed (exit 0).
- `npm test`: failed (exit 1). Reported BoardSwitcher test failures include
  `WorkInbox.jsx:25` calling `.filter` on undefined notification data. Reproduce
  the inbox response/fixture contract before deciding whether to fix the mock
  or production handling. The full stop condition is not met.

## Next increment

First resolve the unit-suite inbox contract failure above. Start feature
acceptance at line 216: run the permanent cards/columns browser test through the
required heavy lock, reproduce any failure in that end-user flow before fixing
it, then extend coverage to keyboard entry, all fields and read-only roles.
Use disposable PostgreSQL and explicit mocks only. Keep later feature work in
checklist order and do not mark these pending rows delivered based on source
presence alone.

## Iteration 2: inbox test contract

Reproduced both BoardSwitcher failures by rendering CanvasView in its existing
component integration tests. The harness returned `{}` for the inbox endpoint,
while Django `work_views.py` returns `notifications` and
`preferences`. Updated the fixture to match that contract and added an assertion
that the loaded board renders `Inbox (0)`. Production behavior is unchanged.
The inbox is briefly mounted while board access loads, then hidden in the
empty-board state. No feature outcome has been promoted by this test repair.

Validation: targeted BoardSwitcher suite passed (7 tests); `npm test` passed
all 936 tests; `npm run lint` passed; `git diff --check` passed. No browser, backend, Docker
stack or persistent server was started. Next increment remains cards/columns
browser acceptance through the heavy lock.

## Iteration 3: card keyboard and field persistence acceptance

Extended the permanent CI browser spec to create a card with D, reopen details
with Ctrl+Shift+Enter, populate title, description, start/end dates, tags, links,
assignee and status, then verify every value after reload. Kept its columns/card
creation and saved-record assertions. Corrected the existing reload flow to
reopen Board, because app navigation returns to Image on reload. Use accessible
roles for dropdowns and populated textareas: exact `getByLabel` queries include
option/textarea text and failed despite the correctly labelled controls being
present. No production code changed and no feature row is promoted yet.

Validation: permanent `Board work:` browser spec passed (1 test, 14.8 seconds)
through the shared heavy lock and `scripts/dev/test-db.sh`, with disposable
PostgreSQL, mock providers and harness-owned Django/workers/Next. The harness
stopped its processes and removed its database on exit. Evidence:
`/var/folders/wk/zf7bhzvs7fs230wlhb95b2900000gn/T/veevee-test.KWiP/browser-qualification`
(ephemeral). `npm test` passed all 936 tests; `npm run lint` passed;
`git diff --check` passed. No commit, push or deployment.

Next smallest increment: finish Cards role and offscreen-edit browser acceptance,
then verify the remaining Columns operations in checklist order. Cmd shortcut
acceptance is also outstanding; this run exercised the supported Ctrl variant.

## Iteration 4: Cards read-only role acceptance

Extended the permanent cards browser test with a separate ordinary user in both
view and comment roles. Both can select the saved card and inspect its title;
all six text/date fields and assignee, status and columns selectors are disabled.
Card/columns creation controls are absent, D does not open a creation panel,
and neither role emits a browser board-save request. Direct PUT attempts return
403 and the owner's subsequent API read confirms unchanged board data.
No production code changed. Cards remains pending Cmd and offscreen acceptance.

Validation: permanent `Board work:` browser spec passed (1 test, 54.3 seconds)
through the shared heavy lock and disposable PostgreSQL harness, using mock
providers. All 936 unit tests and lint passed; `git diff --check` passed.
The harness exited successfully and cleaned up its servers, workers, browser
and disposable database. No commit, push or deployment.

Next increment: verify card editing through the widget selector while the card
is culled offscreen, and the Meta/Cmd details shortcut, before advancing to
Columns acceptance.


## Iteration 5: Cards culling and Cmd acceptance complete

Permanent browser acceptance now exercises Meta+Shift+Enter as well as the Ctrl
variant. It pans the board until the saved card DOM node is absent, selects that
card through Cards and work, changes its description while still culled, checks
the saved API record, and verifies the value after reload. Existing field and
viewer/commenter permission checks still pass. Cards is now recorded as built.
No production code change was necessary.

Validation: `Board work:` browser acceptance passed (1 test, 30.5 seconds) via
`veevee-heavy-lock.sh` and `scripts/dev/test-db.sh`, with disposable PostgreSQL
and mock providers. The harness stopped its owned servers, workers and browser,
and its disposable database was removed. All 936 unit tests and lint passed;
`git diff --check` passed. No commit, push or deployment.

Next increment: Columns acceptance for swimlanes, lane reorder/recolor,
containment and reload persistence. Later feature rows remain pending.


## Iteration 6: Columns lane and swimlane acceptance

Extended the permanent browser flow to add, rename, recolor and reorder columns
and swimlanes, assign a child card to a non-default cell, and verify persisted
parent/lane/swimlane IDs, coordinates and containment. Reload checks preserve
the lane order, colors and card assignments. No production change was needed.
Columns remains pending existing-child reorder, culling and role acceptance.

Validation: browser acceptance passed (1 test, 25.3 seconds) through the shared
heavy lock and disposable PostgreSQL harness with mock providers. All 936 unit
tests and lint passed; git diff checks passed. Harness-owned servers, workers,
browser and database were cleaned up on exit. No commit, push or deployment.

The first browser attempt used system Python without Django; use
`/Users/rohit/Projects/firstmate/data/veevee-board-1b-shapes/venv/bin/python`.
A subsequent selector failure established that CSS-capitalized lane labels
retain lowercase accessible names (`lane`, `swimlane`); corrected selectors
then passed. Next increment: finish Columns acceptance before Tables.


## Iteration 7: Columns read-only role acceptance

Permanent browser coverage now inspects the Columns widget as both a viewer and
a commenter. Every lane/swimlane name and color remains visible but disabled,
as do the widget title, reorder controls, add-column/swimlane/card controls and
Arrange cards. Child lane/swimlane selectors are also disabled. Existing API
403, no browser-save and unchanged persisted-board checks cover both roles.
No production change was required. Columns remains pending existing-child
reordering and offscreen operations.

Validation: permanent `Board work:` browser test passed (1 test, 36.3 seconds)
through the shared heavy lock and disposable PostgreSQL harness with explicit
mock providers. All 936 unit tests and lint passed; git diff checks passed.
The harness exited successfully and cleaned up its owned servers, workers,
browser and database. No commit, push or deployment.
