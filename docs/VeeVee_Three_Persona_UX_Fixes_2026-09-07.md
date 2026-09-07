# VeeVee three-persona audit — implementation and verification

Implemented locally on 2026-09-07 against the Vite frontend and authoritative Django API. Source audit: [VeeVee Three-Persona UX Audit](VeeVee_Three_Persona_UX_Audit_2026-09-05.md).

All 18 findings have an implementation. The director opportunities use optional metadata and a lightweight ordered JSON handoff; they do not introduce a required production taxonomy. The original local implementation did not change production. Subsequent release preparation committed and pushed the changes and deployed isolated previews; see [release evidence](UX_Cutover_Preview_2026-09-07.md). No production deployment, live generation, provider diagnostic, or external agent message was performed.

## Changes by finding

| Finding | Implemented behavior | Main implementation |
| --- | --- | --- |
| UX-001 | Labeled Generate action; configured-rate estimate with batch, reference-image and audio costs; missing rates remain unavailable; token/actual-usage caveats and refresh. | [ComposerEstimate](../src/components/ComposerEstimate.jsx), [estimate calculation](../src/lib/composer-estimate.js), [authenticated pricing read](../backend/apps/common/settings_views.py) |
| UX-002 | Separate “Save to” project/folder state from library browsing; “Unsorted” names the actual destination; persistent creation and browsing context; invalid destinations stop enqueue. | [PromptComposer](../src/components/PromptComposer.jsx), [store](../src/lib/store.js), [HistoryPanel](../src/components/HistoryPanel.jsx) |
| UX-003 | Model hints describe concrete capabilities and reference limits; removed ambiguous ranking badges and unsupported comparative claims. | [Model registry](../src/lib/model-registry.js) |
| UX-004 | “Add references” / “Reference library” wording, reference guidance, optional role labels and keyboard reorder/remove actions; removed unavailable Portrait Gallery entry; removed-reference mentions cannot silently point at a different input. | [PromptComposer](../src/components/PromptComposer.jsx), [mention mapping](../src/lib/mentions.js) |
| UX-005 | Independent mode drafts; compatible per-model settings; unsupported clips/continuation frames remain staged; compatibility preview; validated reload restoration; clone/continuation load inputs before replacing a draft and reject replacement if it changed during loading. | [Composer state](../src/lib/composer-state.js), [store](../src/lib/store.js) |
| UX-006 | Labeled wrapping controls, visible mobile nav labels, scrollable bounded composer, full folder names and stacked narrow folder navigation, balanced/wide desktop library presets. | [Styles](../src/globals.css), [TopBar](../src/components/TopBar.jsx), [HomePage](../src/pages/HomePage.jsx), [ProjectPanel](../src/components/ProjectPanel.jsx) |
| UX-007 | Stronger essential text, metadata and chart labels; explicit control-border/focus tokens; focus treatment survives utility overrides; reduced-motion skeleton behavior. | [Styles](../src/globals.css), affected composer/library/admin components |
| UX-008 | Pricing, global limits and per-user limits use row-local dirty state, old/new preview and Apply/Cancel. Role changes require an explicit review dialog. | [EditableSetting](../src/components/EditableSetting.jsx), [AdminDashboard](../src/components/AdminDashboard.jsx) |
| UX-009 | Save helpers reject non-2xx and invalid responses; edits remain available after failure. Project briefs use explicit Save/Cancel and update the in-memory accepted project after success. | [API helper](../src/lib/api.js), [ProjectPanel](../src/components/ProjectPanel.jsx), [EditableSetting](../src/components/EditableSetting.jsx) |
| UX-010 | Configured-only, cached credentials and completed checks have distinct labels; configuration is excluded from passed-check totals; full check timestamp; status checks and diagnostics require explicit activation. | [Evidence classification](../src/lib/status-evidence.js), [AdminDashboard](../src/components/AdminDashboard.jsx) |
| UX-011 | Overview and generation Logs share date/project scope, UTC labels and full chart dates. Headline and per-user cost chart aggregates use the selected scope; current registered-user count and all-time Users tab are explicitly distinguished. CSV inherits the log scope. Token recovery moved to Integrations. | [Admin stats](../backend/apps/admin_dashboard/admin_stats.py), [Admin logs](../backend/apps/admin_dashboard/admin_logs.py), [AdminDashboard](../src/components/AdminDashboard.jsx) |
| UX-012 | Separate keyboard Open asset buttons in cards and conversation media; dialog semantics, focus containment and focus return; opening never invokes download. | [MediaCard](../src/components/MediaCard.jsx), [DetailModal](../src/components/DetailModal.jsx), [dialog focus](../src/components/useDialogFocus.js) |
| UX-013 | Comfortable/compact details, visible model/time/shot/review information, full-library model/date/review filters and newest/oldest ordering, visible scope and clear filters. Counts, cache identity, pagination and live membership use the same filters. | [HistoryPanel](../src/components/HistoryPanel.jsx), [feed scope](../src/lib/feed-scope.js), [Django history](../backend/apps/generation/generations_service.py) |
| UX-014 | Optional scene/shot/take and notes; immutable source/relationship/final-frame context; source/derived-take navigation; labeled approved continuity references attached to the take. | [ProductionDetails](../src/components/ProductionDetails.jsx), [production API](../backend/apps/generation/production_views.py), [generation enqueue](../backend/apps/generation/generation_views.py) |
| UX-015 | Side-by-side comparison, separate Candidate/Needs changes/Approved states, server-attributed reviewer/time/history, conflict detection and explicit review saves. Ordered handoff includes identifiers, prompts, parameters, references, lineage, review data and media links. | [TakeReviewDialog](../src/components/TakeReviewDialog.jsx), [manifest](../src/lib/handoff.js), [production API](../backend/apps/generation/production_views.py) |
| UX-016 | Empty Board/Agents lists make no create request; explicit creation, loading/error distinction, retry, stale-scope guards, and no replacement record after deleting the last entry. No-chat entry is informative and Send is disabled. | [BoardSwitcher](../src/components/canvas/BoardSwitcher.jsx), [CanvasView](../src/components/canvas/CanvasView.jsx), [ChatSidebar](../src/components/ChatSidebar.jsx), [StudioChat](../src/components/StudioChat.jsx) |
| UX-017 | Preparation actions say “Load prompt & settings” and “Continue from last frame”; billable confirmations remain. Failed jobs distinguish account, input and temporary problems, with technical detail available in the viewer. | [Error classification](../src/lib/generation-error.js), [DetailModal](../src/components/DetailModal.jsx), [ConversationPanel](../src/components/ConversationPanel.jsx) |
| UX-018 | Generation/activity log filters have meaningful accessible names; every editable rate/limit has its model/user/unit-specific label; ordinary keyboard navigation performs no configuration save. | [AdminDashboard](../src/components/AdminDashboard.jsx), [EditableSetting](../src/components/EditableSetting.jsx) |

## Verification

- `npm run lint`: passed with zero warnings.
- `npm test -- --reporter=dot`: **80 test files, 811 tests passed**. Includes real DOM tests for explicit commits, failed-save recovery, and empty Board/Agents creation; pure tests cover compatibility, restored drafts, costs, error/status semantics, retrieval scope and handoff contents.
- Django tests across generation, admin, common, canvas, agents, projects, assets and media: **430 passed** against a disposable PostgreSQL instance at loopback port 55439. Provider execution in automated tests uses the existing mocks; no live generation was used for verification.
- Production Vite build: passed with an intentionally non-routable test API origin. Existing `video-frame` static/dynamic import warning remains; it does not affect build success.
- Migration `generation.0008_generation_production_metadata`: applied successfully to an isolated database representing the prior schema. The new JSONB column is non-null with database default `{}`; a raw insert omitting the column succeeded and returned `{}`, confirming compatibility with older writers. `makemigrations --check --dry-run`: no changes detected.
- Local Chrome UI with synthetic data: desktop, 1366×768 laptop, and 390×844 phone layouts inspected. Model/settings/destination/Generate remain visible. The phone drawer settled at x=39, width=351, with scrollWidth=clientWidth=351.
- Keyboard Open → viewer → Escape returned focus to the originating Open asset button. Comparison close returned focus to its launch action.
- Explicit local review saved and displayed the test reviewer's name/time; comparison displayed the approval; reordering changed manifest order. Manifest contents/order are also asserted in a unit test.
- Local Image → Video → Image retained separate text; reload restored the active image draft. No Generate action was activated.
- Local Board and Agents entry left **0 boards / 0 conversations** in the fixture database. Tests separately verify one explicit create request per action and failure-versus-empty behavior.
- Local Admin: editing a price and pressing Tab displayed the unsaved old/new preview; Cancel restored the rate. Status opened as “Not checked in this session” without running checks.
- Local browser smoke testing caught and fixed duplicate React keys in viewer sections, then rechecked the clean build.

### Rendered contrast samples

Read computed colors in Chrome, composite alpha against the actual ancestor background, then calculate sRGB relative luminance. These are targeted measurements, not a full accessibility certification.

| Sample | Rendered colors / result |
| --- | --- |
| Inactive navigation | white at 70% on RGB(7,7,8): **9.78:1** |
| Composer placeholder | white at 70% on composited RGB(16,16.9,18.8): **9.48:1** |
| Browsing context | white at 80% on RGB(12,13,15): **12.43:1** |
| Control border token | #717680 on #181a1e: **3.82:1** |
| Focus token | #e5e7eb on #181a1e: **14.07:1** |

## Activation and practical limits

Apply the additive Django migration before serving the new backend/frontend. Django remains the schema authority; the retained Drizzle schema/read helper mirrors the new field and retrieval contract. No migration was run against production. Rolling the application back should retain the additive metadata column rather than drop review data.

The authenticated internal team library remains shared according to existing access rules; this change does not add new ordinary-user project isolation. Existing generations have empty metadata and remain usable. Historical lineage cannot be reconstructed automatically; new clones/continuations record their source. Worker upserts deliberately omit human review metadata, preventing late provider results from overwriting it.

The handoff is an ordered JSON manifest with authorized media links, not a media ZIP or editing-software timeline. Existing image ZIP download remains available. Review of at most 100 direct descendants and the last 100 review transitions is shown. Large reference drafts remain subject to browser storage quota; the UI explicitly warns if only the current tab retains the draft. Board editing retains its existing desktop-only requirement.

Generation quality, real provider readiness/billing, physical-device behavior and full screen-reader usability were not tested. Saved-view presets, a media-inclusive editor package and enforced production taxonomy remain product opportunities rather than implied capabilities of these fixes.
