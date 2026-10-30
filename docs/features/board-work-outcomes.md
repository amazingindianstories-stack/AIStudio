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
| 216 | Cards | M | Pending verification | `WorkTools` implements structured fields, existing-user assignees, D and Cmd/Ctrl+Shift+Enter; `WorkNode` renders cards. Existing browser spec covers details and reload. Verify keyboard, roles, offscreen edits and all fields end to end. |
| 217 | Columns | M | Pending verification | `work-records.layoutColumns` uses board data; `WorkTools` adds, renames, recolors and moves lanes upward. Verify swimlanes, reorder, containment and persistence end to end. |
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
