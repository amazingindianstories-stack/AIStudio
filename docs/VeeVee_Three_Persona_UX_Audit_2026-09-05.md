# VeeVee three-persona UI/UX audit

Requested report date: **2026-09-05**. Live inspection performed **2026-09-07, Asia/Kolkata**. The requested filename is retained; this is not a claim that the live observations were made on September 5.

Scope: [VeeVee workspace](https://www.veevee.ai/) and [admin dashboard](https://www.veevee.ai/admin), using the existing authenticated admin session. Newbie, experienced artist, and director are simulated perspectives, not recruited participants or separately verified permission levels. Local source reviewed at commit `43fcfa9`; the deployed revision was not established.

## Executive assessment

VeeVee has a useful creative-workbench foundation: a restrained dark canvas, large media previews, a compact composer, searchable project history, and practical video iteration controls. Its strongest experience is an experienced operator inspecting an individual result. The largest opportunity is to make the relationship between **what I am creating, what I am browsing, where the result will go, and what it will cost** explicit.

The existing take viewer already exposes parameters, seed, reference images, frame reuse, continuation, cloning, and download. These should be retained and made easier to understand. This audit does not recommend building those capabilities again. Likewise, history already has database-backed prompt search in source, type filters, favourites, folders, and thumbnail sizing; admin reporting already distinguishes reconciled and estimated spend.

The main friction points are hidden context in compact controls, uneven terminology, a gallery-oriented workflow for work that needs scene and take structure, and inconsistent administrative save behavior. At laptop and narrow-screen widths, reduced labels magnify the context problem. Some higher-risk behaviors are source findings, not incidents reproduced in production.

### Ten highest-value improvements

Rank reflects expected value and risk, not a measured conversion impact. Effort is an initial engineering/design estimate, not a delivery commitment.

| Rank | Improvement | Finding | Priority | Effort |
| --- | --- | --- | --- | --- |
| 1 | Show a configuration-aware estimate beside Generate, including batch and audio | [UX-001](#ux-001) | P1 | M |
| 2 | Make pricing, limits, and role changes explicitly reviewable before applying | [UX-008](#ux-008) | P1 | M |
| 3 | Report successful saves only after successful responses; retain failed edits | [UX-009](#ux-009) | P1, source | M |
| 4 | Preserve separate mode settings and explain incompatible model changes | [UX-005](#ux-005) | P1, source | M |
| 5 | Label creation mode, browsing scope, and output destination independently | [UX-002](#ux-002) | P1 | S–M |
| 6 | Keep model, destination, and essential settings readable at smaller widths | [UX-006](#ux-006) | P1 | M |
| 7 | Make models and reference entry understandable in creative language | [UX-003](#ux-003), [UX-004](#ux-004) | P2 | S–M |
| 8 | Give media cards a reliable keyboard-accessible Open action | [UX-012](#ux-012) | P1, source-supported | M |
| 9 | Add scene/shot/take context and visible derivation links to existing iteration tools | [UX-014](#ux-014) | P2 opportunity | L |
| 10 | Distinguish configured providers from operational evidence in Status | [UX-010](#ux-010) | P2, source | S–M |

## Method, evidence, and boundaries

- **B — Browser observation:** observed in the live session through screenshots, accessibility trees, or read-only DOM inspection. Evidence entries below record the state and steps without copying customer prompts, contact information, or record identifiers.
- **S — Source-backed behavior:** supported by the linked local implementation. This does not establish identical behavior in the deployed build. For example, the live Seedance 2.5 menu mentioned 1080p while the local registry hint reviewed mentioned 480p/720p; live observations take precedence for live UI claims.
- **R — Recommendation:** the auditor's design judgment. Proposed outcomes and acceptance criteria are not test results.
- **H — Hypothesis/opportunity:** a proposed workflow benefit requiring validation with real users. Absence claims are limited to inspected surfaces and reviewed files.

Desktop inspection used the existing approximately **1920 × 795** content viewport, then temporary **1366 × 768** and **390 × 844** overrides. The override was reset. Device emulation did not test a physical phone, touch behavior, virtual keyboards, or OS text scaling.

Menus, history filters, existing media details, project brief, account forms, and admin reporting were inspected. No generation, regeneration, retry, agent message, upload, save, delete, favourite, permission change, credential entry, or explicit diagnostic action was performed. Composer fields and settings were not changed. A media-card inspection landed on a Download overlay; this is not counted as a verified export or handoff workflow. No downloaded customer media is included in this report.

Board and Agents were not entered: local code can create their first records on mount, and safe authenticated evidence of existing records for the selected project/agent type was not established through the available read-only UI. Status was also source-only: mounting it calls a status-check endpoint that performs active checks; the plan prohibited invoking diagnostics. No credentials were extracted to work around these limits.

Image and Depth mode switching was intentionally not exercised because `setMode` resets composer settings. Their controls were source-reviewed; existing image history was browser-inspected. This preserves the active Video draft rather than assuming a mode round trip is harmless. Material upload and library attachment flows were not completed.

The selected project count changed during the session, consistent with a live, updating workspace; counts are snapshots, not reconciliation evidence. Loading states were allowed to settle before classification. An initially off-screen mobile drawer became correctly positioned and was not reported as a persistent layout defect. Some pointer/menu transitions required a fresh state check and keyboard activation; no general latency or click-failure claim is made from those attempts.

Screenshots were inspected in-session for visual findings. They are not attached because the full screens contain customer imagery, avatars, prompts, or account data. The sanitized observation ledger and source links are the supporting evidence; this document does not claim a retained screenshot archive.

### Coverage matrix

“Inspected” means the stated read-only task was exercised, not that the full feature was tested. “Limited” names the boundary. “Untested” means no execution.

| Surface / persona task | Coverage | What was inspected / limitation | Evidence |
| --- | --- | --- | --- |
| Newbie: locate starting action and understand navigation | Inspected | Populated admin workspace, Video composer and Generate; no first-run account | B01, B02 |
| Newbie: choose a model | Limited | Video picker opened; no model selected or output produced; image registry source-reviewed | B02, S01 |
| Newbie: understand references | Limited | Material menu and prompt placeholder; no attachment, upload, reorder, or removal | B03, S01 |
| Newbie: interpret settings, cost, destination | Inspected | Video settings and destination menus opened without changing inputs | B02, B03 |
| Newbie: locate previous work | Inspected | Opened assets panel, Videos filter, no-match search and clear | B04 |
| Artist: image controls and prompt editing | Limited | Existing image feed; composer/source review; no mode change, prompt edits, or expanded editing workflow | B01, S01, S02 |
| Artist: video controls and capabilities | Inspected | Model descriptions; task, aspect, resolution, duration, batch and audio controls | B02 |
| Artist: media inspection and reproducibility | Limited | Opened existing video details; inspected parameters, seed and references; no repeatability test | B05, S03 |
| Artist: iteration and continuation | Limited | Controls and source inspected; clone, continuation, frame reuse and retry not activated | B05, S03 |
| Artist: history search and precision | Inspected | Type filter settled; unique no-match search returned contextual guidance; cleared/restored | B04 |
| Director: project/folder organization and brief | Inspected | Project scope, folder counts, Unsorted and brief editor; no folder or brief edits | B03, B04, S04 |
| Director: existing takes and review cues | Limited | Video viewer and historical failed cards; quality flag exists, not changed | B05 |
| Director: Board organization | Limited, source only | Board switcher, project context, tools, save lifecycle, desktop gate | S05 |
| Director: comparison, approval, handoff | Limited | Single-take viewer and download affordance; no comparison session, approval or export package tested | B05, S03, S05 |
| Agents | Limited, source only | Project/type-scoped conversation initialization and chat display | S06 |
| Depth | Limited, source only | Video input, worker availability, encoder labels and submit path; nav status dot seen | B01, S07 |
| Admin Overview | Inspected | Settled metrics, charts, estimate/reconciled labels, credential-seeding form | B08 |
| Admin Users | Limited | Table, role controls, own-role protection, status and action affordances; no actions applied | B09, S08 |
| Admin Logs and Activity | Limited | Settled rows/counts, filters, search and CSV affordance; failed-filter keyboard attempt not verified as applied; exports not run | B10, S08 |
| Admin Pricing / Limits | Limited | Forms and copy read; save-on-blur inputs never focused | B11, S08 |
| Admin Status | Limited, source only | Config-presence checks, aggregate OK summary, refresh and diagnostic paths | S09 |
| Account Profile / Security | Limited | Both tabs and empty forms inspected; explicit save buttons; no password or profile change | B12, S10 |
| Laptop / narrow layout | Inspected | Workspace at two sizes, settled mobile history drawer | B06, B07 |
| Keyboard interaction | Limited | Model/settings Escape; account menu Enter; mobile drawer Tab and Escape | B07, B12 |
| Ordinary-user permissions, first-time onboarding, backend reliability, generation quality | Untested | No account switch, generation, load test, or provider probe | — |

## Persona journeys

### Newbie: “Where do I start, and what happens when I press Generate?”

**Expectation:** select an image or video task, understand the model and optional references, see the price and destination, then find the result.

**Actual path:** the session opened on Video with an empty composer below an existing image feed. The primary generation action is a compact arrow, disabled while the prompt is empty. The top navigation says Video while the composer repeats AI Video. Opening the model menu reveals useful constraints, but also terms such as ModelArk, Interactions API, and NBP-style scaffolding. The plus entry is labeled “material,” and the placeholder teaches `@img1` syntax before explaining reference roles. Settings contain the video task, duration, batch and audio. Destination is another compact chip; “All” appears as its folder value. Previous work becomes much easier to locate once the assets panel is open.

**Friction:** a newcomer must infer whether Video filters the visible results, whether “All” means an output folder or a view, and what the selected settings cost. The controls exist, but their relationship is under-explained. This was a populated admin session, so the actual first-run empty state remains untested.

**Better flow (R):** keep the current workbench, add a concise task cue (“Create a video”), label the destination “Save to,” show an estimated total, and offer a plain-language model recommendation with expandable technical details. “Add references” should explain optional image/clip roles before introducing mention syntax. Generation status should identify the destination and link to the result when work completes; that last step is proposed, not tested here.

### Experienced artist: “Let me control the result without losing my working context.”

**Expectation:** precise model-compatible controls, fast reference handling, searchable history, and predictable iteration from an existing take.

**Actual path:** model and settings menus expose useful video capabilities. The assets panel provides prompt search, media-type filtering, folders and size controls. A Videos filter reduced the selected project's results, and a unique search produced a correct project-specific no-match message. Opening a completed video exposed resolution, aspect, duration, model, seed, references and multiple iteration actions. No iteration action was executed.

**Friction:** visual comparison depends on thumbnails or serial inspection; long, similar takes have little persistent identifying context in the compact grid. At laptop width, opening the library shrinks the composer enough to hide important chip labels. Source review shows a mode switch resets model and settings rather than retaining a separate per-mode setup. Cloning and continuation have useful source-defined confirmation copy, but names such as “Clone & try” require the user to discover whether they load a draft or start paid work.

**Better flow (R):** retain model-specific settings per mode, show compatibility changes before discarding inputs, provide a compact/comfortable library choice, expose asset metadata on demand, and distinguish “Prepare in composer” from “Generate again.” Add a two-take comparison using existing parameters and reference metadata. Reproducibility should describe saved inputs and seed availability without promising pixel-identical provider output.

### Director: “Which take is approved, what came before it, and what happens next?”

**Expectation:** navigate project → scene → shot → takes, compare candidates, preserve continuity, select an approved take and hand off an ordered sequence.

**Actual path:** project selection, folder grouping, Unsorted and a project brief are available. The inspected project had hundreds of items, with many in Unsorted. The video viewer already offers “Continue this shot,” frame reuse and whole-clip reference reuse. A quality-review flag and favourites exist. Board implementation offers spatial organization, frames, text, sticky notes and connectors, but Board itself was not browser-tested.

**Friction:** the inspected library is primarily a collection of individual media results. Scene numbers, take labels, derivation relationships, approval decisions and ordered handoff are not visible in the inspected viewer/library. A quality flag and a favourite do not tell the reviewer which take is the approved story choice. Generic board tools could organize this manually, but that is a hypothesis because no existing board was inspected.

**Better flow (H):** begin with lightweight scene/shot/take metadata, then expose continuation lineage and pinned continuity references. Add two-take comparison and explicit review states before building a larger sequencing system. Validate whether directors want a shot list with an optional board view; do not assume a full nonlinear editor is required. A later handoff can package an ordered set of selected takes with identifiers and metadata.

## Findings

Severity: **P1** = substantial task confidence, accessibility, draft, or configuration risk; **P2** = repeated workflow friction or meaningful product opportunity; **P3** = polish. No P0 outage or data-loss incident was established. Effort: **S** ≈ 1–3 engineering/design days; **M** ≈ 4–10 days; **L** = multi-week discovery and implementation. Estimates include targeted validation and depend on existing architecture.

<a id="ux-001"></a>
### UX-001 — The composer does not show a total cost estimate

- **Location / reproduce:** workspace → Video → Generation settings; inspect duration, batch, audio and the Generate area without submitting.
- **Evidence:** **B02** shows an audio surcharge explanation but no numeric estimate beside Generate or in settings. **S01** has no composer cost-estimate rendering. Admin Pricing separately explains model, resolution, duration and audio scaling (**B11**).
- **Affected / severity / effort:** newbie, artist, director; **P1 / M**.
- **Recommendation (R):** display “Estimated total” for the selected model, resolution, duration, batch and audio, with a breakdown and an unavailable-estimate state. Do not present internal estimated cost as a verified customer charge or provider invoice.
- **Acceptance:** changing each supported cost-driving control updates the estimate; batch totals and audio are explicit; unavailable rates never display a misleading zero; the estimate remains visible at all audited widths.

<a id="ux-002"></a>
### UX-002 — Creation mode, browsing scope and destination are easy to conflate

- **Location / reproduce:** open the Video workspace with assets collapsed; inspect the image feed, project/All assets strip, and Generation destination → folder selection. Then open assets and choose Videos.
- **Evidence:** **B01–B04**: Video remained selected while image results were visible; Videos was a separate history filter. Destination displayed the project followed by “/ All,” with “All assets” as the selected folder menu option.
- **Affected / severity / effort:** all three personas; **P1 / S–M**.
- **Recommendation (R):** label the regions “Create,” “Browse,” and “Save to.” Use “Project root / Unsorted” or another accurate storage label instead of “All” for a destination. Clarify scope in place without automatically hiding useful cross-media history.
- **Acceptance:** a novice can identify the generation type, visible-history scope and output destination before submitting; changing a browse filter does not silently change output routing.

<a id="ux-003"></a>
### UX-003 — Model guidance mixes useful constraints with provider jargon

- **Location / reproduce:** Video → model picker; read the three visible model descriptions without selecting one.
- **Evidence:** **B02** exposes useful duration/reference/face restrictions alongside “BytePlus ModelArk direct,” “Google Interactions API,” “NBP-style,” DIRECT and NEW. **S01** also contains image capability hints and BEST/BUDGET badges.
- **Affected / severity / effort:** newbie and artist; **P2 / S–M**.
- **Recommendation (R):** lead with intended use, supported inputs, constraints and estimated cost; put API/provider implementation detail in secondary disclosure. Define the basis for comparative badges rather than implying measured quality from the badge alone.
- **Acceptance:** each offered model has comparable fields; reference limits and unsupported tasks are readable before selection; technical acronyms are expanded or secondary. No generation-quality ranking is asserted without evidence.

<a id="ux-004"></a>
### UX-004 — Reference entry needs a clearer vocabulary and role model

- **Location / reproduce:** composer → “material” plus menu; inspect Local upload, Attach clip, Material library and disabled Portrait Gallery; read the prompt placeholder.
- **Evidence:** **B03** uses three overlapping terms—material, references and uploaded images—and introduces `@img1`/`@img2`. A disabled Portrait Gallery item is present. No attachment workflow was tested.
- **Affected / severity / effort:** newbie, artist, director; **P2 / S** for wording, **M** for role UI.
- **Recommendation (R/H):** rename the entry “Add references,” explain supported image/clip inputs, and clarify the disabled item. Prototype optional reference labels such as identity, costume and composition, explicitly as organizational intent rather than guaranteed model enforcement.
- **Acceptance:** the empty composer explains how references influence a task and how to mention them; disabled choices explain availability; adding/reordering references preserves correct mention mappings in later dedicated tests.

<a id="ux-005"></a>
### UX-005 — Mode switches reset settings; model switches can discard incompatible input

- **Location / reproduce in a disposable test session:** configure Video, switch Image, then return to Video; separately switch from a model supporting video references to one that does not.
- **Evidence:** **S02**, `setMode`, assigns default model/aspect/resolution and resets video task mode. `setModel` clamps settings and clears unsupported video references. This behavior was **not activated live** to preserve the draft. Prompt loss is not claimed.
- **Affected / severity / effort:** artist and director; **P1 / M**.
- **Recommendation (R):** retain per-mode settings/drafts, stage incompatible references rather than discard them, and explain necessary adjustments when selecting a model. Existing clone/continuation confirmation copy should remain.
- **Acceptance:** Image → Video round trips retain each mode's settings; incompatible inputs remain recoverable; a compatibility notice identifies changes before a new billable submission.

<a id="ux-006"></a>
### UX-006 — Responsive compression hides decision-critical context

- **Location / reproduce:** open the assets panel at 1366 × 768; inspect composer controls. At 390 × 844, inspect navigation, composer and the settled assets drawer.
- **Evidence:** **B06**: laptop composer reduced mode, settings and destination to icons. **B07**: mobile model name truncated, top navigation lost visible labels, and folder labels became fragments. The settled drawer fit at x=39, width=351 within the 390px viewport; no persistent off-screen drawer defect was found.
- **Affected / severity / effort:** all three personas; **P1 / M**.
- **Recommendation (R):** allow a labeled second composer row, a concise persistent configuration summary, and a folder breadcrumb or drill-in view on narrow screens. Offer resizable or preset library widths on desktop.
- **Acceptance:** model, output destination and key settings remain understandable without hover at both test sizes; drawer folders can be identified without guessing truncated labels; Generate stays reachable and content does not overlap.

<a id="ux-007"></a>
### UX-007 — Low-emphasis text weakens an otherwise coherent dark visual system

- **Location / reproduce:** desktop composer placeholder, feed metadata, navigation and folder captions; compare them with prominent media and primary actions.
- **Evidence:** **B01, B06, B07** screenshots show subdued secondary text and thin boundaries against near-black panels. Source uses small type and white opacity variants in **S01, S04, S11**. This is a visual judgment, not a measured contrast-compliance failure.
- **Affected / severity / effort:** all personas, especially newcomers; **P2 / S–M**.
- **Recommendation (R):** raise emphasis for essential labels and metadata, reserve faint text for genuinely secondary content, and establish tested tokens for body, secondary text, dividers and focus indicators.
- **Acceptance:** measure rendered colors rather than infer contrast from opacity names; target at least 4.5:1 for normal essential text and 3:1 for large text and necessary non-text indicators; verify focus and disabled states separately.

<a id="ux-008"></a>
### UX-008 — Administrative fields apply changes with inconsistent commitment rules

- **Location / reproduce safely:** Admin → Pricing, Limits and Users; inspect controls without focusing price/limit fields or changing roles. Review the handlers in S08 rather than applying a production change.
- **Evidence:** **B09, B11, S08**: pricing and global limits save on blur; other-user roles patch immediately on change. Account settings has an explicit Save changes button (**B12**). Own-role changes are disabled, and source provides confirmations for some other user actions—this is not a claim that all admin actions lack safeguards.
- **Affected / severity / effort:** admin; **P1 / M**.
- **Recommendation (R):** stage configuration edits with visible dirty state, old/new values and Apply/Cancel. Explain whether an edit affects future generations, defaults or one user's effective limit. Require a deliberate application step for role changes.
- **Acceptance:** tabbing through unchanged inputs sends no write; edits can be reviewed/cancelled; role changes require an explicit apply action; success/error appears beside the affected row.

<a id="ux-009"></a>
### UX-009 — Several save paths do not distinguish HTTP failure from success

- **Location / reproduce in a test environment:** make a pricing/limit/project-brief save return a non-2xx response; observe displayed feedback and retained input.
- **Evidence:** **S08** PricingTab awaits `apiFetch` then reloads without checking `res.ok`; GlobalLimitCard can set `saved=true` after a resolved error response. **S04** BriefEditor similarly updates its saved baseline after awaiting `apiFetch`. **S12** confirms `apiFetch` is a fetch wrapper, not a non-2xx-throwing helper. No failed save was induced live.
- **Affected / severity / effort:** admin, artist and director; **P1 / M**, source-backed risk.
- **Recommendation (R):** validate status and structured response before declaring success; retain dirty input and expose a clear retry/error state. Reuse existing response-parsing utilities where suitable.
- **Acceptance:** representative 400/403/500 and network failures never show Saved, never replace the accepted baseline, and leave edits recoverable; a successful response alone clears dirty state.

<a id="ux-010"></a>
### UX-010 — “OK” combines different strengths of provider evidence

- **Location / reproduce by source inspection:** Admin Status summary and backend provider check definitions; no live probe required for this finding.
- **Evidence:** **S09**: configured Seedance/Kling/Omni checks can return `status: "ok"` for configuration presence; other checks perform reads or examine freshness. UI aggregates statuses into an “OK” count. Detail text already says “config-presence only” for some providers, so the nuance exists but is subordinate.
- **Affected / severity / effort:** admin and directors assessing readiness; **P2 / S–M**.
- **Recommendation (R):** separate “Configured,” “Authentication checked,” “Service reachable” and “Recent successful job,” with timestamp and evidence type. Do not turn a green configuration indicator into a guarantee of operational availability.
- **Acceptance:** a configured but untested provider is labeled as such in the summary and row; stale evidence is visible; diagnostics remain an explicit, separate action.

<a id="ux-011"></a>
### UX-011 — Routine admin reporting lacks a clear period and includes credential recovery

- **Location / reproduce:** Admin → Overview; read metric labels, charts and the lower token-seeding form. Then inspect Logs filters.
- **Evidence:** **B08** shows spend/generation/user metrics and estimate breakdowns, charts with month-day labels, and a Higgsfield token-seeding form on the same overview. **B10** shows useful operational filters but no visible date-range or project filter in the inspected filter bar. The source preserves historical provider paths (**S01**); the token form is not proof a provider is currently offered.
- **Affected / severity / effort:** admin; **P2 / M**.
- **Recommendation (R):** add explicit reporting period/timezone, period and project filters where supported, and move credential recovery into a clearly labeled integration-maintenance area. Retain reconciled-versus-estimated distinctions.
- **Acceptance:** every metric states its period; filtered totals and exports share scope; routine Overview contains no credential-entry field; maintenance copy explains its applicable provider path.

<a id="ux-012"></a>
### UX-012 — Media-card opening is not exposed as a clear keyboard action

- **Location / reproduce in accessibility testing:** library → completed media card; tab through controls and attempt to open the viewer independently of Select, Favourite, Download and Delete.
- **Evidence:** **B04–B05** expose action buttons but the card itself is a generic container. **S13** renders the clickable outer card as `motion.div` with `onClick` and no equivalent button/keyboard semantics there. A thumbnail inspection hit its Download overlay before a lower thumbnail area opened the viewer. A complete screen-reader journey was not performed.
- **Affected / severity / effort:** keyboard users across all personas; **P1 / M**.
- **Recommendation (R):** provide a named “Open asset” control, keyboard activation and visible focus without nesting interactive buttons. Keep hover actions from obscuring the primary inspection target, especially on small wide-aspect thumbnails.
- **Acceptance:** keyboard-only users can open and close an image/video viewer and return focus to its card; accessible names identify the asset concisely; primary inspection does not trigger download or mutation.

<a id="ux-013"></a>
### UX-013 — History is searchable, but repeated takes remain hard to distinguish

- **Location / reproduce:** assets → selected project → All types or Videos; compare similar thumbnails and available filters.
- **Evidence:** **B04** provides prompt search, type filtering, project/folder scope, favourites and zoom. Compact cards emphasize imagery and creator markers; stable take names, model/date filters and sort controls were not visible in the inspected library. This is not a claim that search only covers loaded items: **S11** explicitly describes database-backed search.
- **Affected / severity / effort:** artist and director; **P2 / M**.
- **Recommendation (R):** add a comfortable list/grid density with concise name, model, time and status; introduce model/date/sort filters and saved views only after validating frequent retrieval tasks.
- **Acceptance:** users can identify a known take without opening several nearly identical cards; active filters and result scope remain visible; “Clear filters” restores a known state without changing the composer.

<a id="ux-014"></a>
### UX-014 — Continuation tools need visible shot context and lineage

- **Location / reproduce:** project library → completed video → viewer; inspect metadata and “Continue this shot.” Review the continuation handler without executing it.
- **Evidence:** **B05** has continuation and reference controls but no visible scene/shot/take identifiers or parent/child navigation. **S03** describes continuation from the final frame and replacing the composer. Existing capabilities are substantial; no continuity quality was tested.
- **Affected / severity / effort:** director and artist; **P2 / L**, opportunity grounded in viewer context.
- **Recommendation (H):** introduce optional scene/shot/take fields and visible “derived from / continued by” links. Pin continuity references with clear human labels. Validate the structure against actual production organization before requiring it for every asset.
- **Acceptance:** a continuation can be traced to its source take and frame choice; the reviewer can navigate both directions and identify approved references without reconstructing history from prompts.

<a id="ux-015"></a>
### UX-015 — Selection, quality flags and production approval are different decisions

- **Location / reproduce:** video viewer and library; inspect favourite, quality-review flag and download. Source-review Board tools and metadata.
- **Evidence:** **B05** exposes a quality-review flag and favourites but no visible approval state, review notes, comparison pane or ordered handoff. **S05** offers generic spatial tools; no claim is made about the content of existing boards or the absence of capabilities elsewhere.
- **Affected / severity / effort:** director; **P2 / L**.
- **Recommendation (H):** start with two-take comparison and explicit review states such as Candidate, Needs changes and Approved, separate from quality flags. Add an ordered handoff package only after validating director/editor needs; reuse existing download capability.
- **Acceptance:** a reviewer can compare two candidates and see who approved which take; a handoff preserves order, identifiers and relevant metadata. These are future criteria, not completed-flow claims.

<a id="ux-016"></a>
### UX-016 — Entering Board or Agents can create an unrequested empty record

- **Location / reproduce in a disposable project:** open Board with no boards; open Agents for a project/type with no conversations.
- **Evidence:** **S05** BoardSwitcher issues a create POST after an empty list. **S06** ChatSidebar similarly creates a conversation for an empty project/agent-type list. Neither branch was exercised live.
- **Affected / severity / effort:** newbie, director and admin; **P2 / S–M**.
- **Recommendation (R):** show an informative empty state and create only on an explicit “Create board” or “Start conversation” action. Explain scope before creation; keep successful existing-record navigation intact.
- **Acceptance:** visiting and leaving an empty surface performs no create request; explicit creation produces one record in the shown scope; loading and failure states cannot masquerade as empty-success states.

<a id="ux-017"></a>
### UX-017 — Iteration labels and historical errors need clearer next actions

- **Location / reproduce:** existing video viewer → inspect Clone & try, Continue this shot, Regenerate (same seed); inspect a historical failed video card without retrying.
- **Evidence:** **B05** mixes preparation and generation actions. A historical failed card exposes a raw provider overdue-account error and request identifier, with an Edit action. This does not establish current provider failure. **S03** already contains explicit billable-generation and draft-replacement confirmations.
- **Affected / severity / effort:** newbie, artist and admin; **P2 / S–M**.
- **Recommendation (R):** label preparation actions by their result (“Load in composer,” “Prepare next shot”), retain confirmations, and classify errors into user-editable, temporary and admin/provider-action categories. Put raw error detail in disclosure.
- **Acceptance:** users can tell before activation whether an action prepares or generates; a provider-account problem directs the user to appropriate operational help rather than implying a prompt edit fixes it; technical details remain available for support.

<a id="ux-018"></a>
### UX-018 — Administrative filter and input labels need accessible associations

- **Location / reproduce:** Admin Logs comboboxes and Pricing/Global Limits numeric fields; inspect accessible names without focusing save-on-blur fields.
- **Evidence:** **B10** exposes unnamed comboboxes whose selected options carry the context. **B11** exposes bare numeric steppers. **S08** renders log selects without associated labels; pricing inputs lack model-specific labels; GlobalLimitCard labels lack a `for`/nested-input association. In contrast, account fields and per-user role controls have useful labels.
- **Affected / severity / effort:** admin using assistive technology; **P2 / S**.
- **Recommendation (R):** associate visible labels with controls, distinguish generation-log versus activity user filters, and include model/unit context in pricing input names. Preserve concise visible layout.
- **Acceptance:** an accessibility-tree inspection exposes unique, meaningful names for every filter and numeric field, independent of its current value; keyboard review does not itself write configuration.

## Dedicated visual-feel review

These are design judgments based on the observed workspace and responsive screenshots, not a visual redesign specification or formal accessibility certification.

| Dimension | What works | Friction and direction | Related findings |
| --- | --- | --- | --- |
| Hierarchy | Large media remains the visual focus; nav selection and bright iteration actions stand out | The creation task, history scope and destination need stronger separation; a small arrow carries the main generation action | UX-001, UX-002 |
| Contrast | Dark surroundings reduce visual competition with artwork | Essential placeholder/metadata text and thin panel boundaries feel too faint; measure and tune tokens | UX-007 |
| Typography | Consistent sans-serif family; compact controls are visually coherent | Small metadata, folder captions and badge text sacrifice legibility; technical acronyms increase reading effort | UX-003, UX-007 |
| Spacing | Generous media area and rounded surfaces feel calm on desktop | Collapsed desktop library leaves substantial negative space, while opening it produces a dense split; offer controllable density/width | UX-006, UX-013 |
| Density | Thumbnail sizing and collapse controls already support different tasks | Laptop composer loses useful labels; mobile folder rail competes with the single-column media view | UX-006 |
| Icon clarity | Many controls expose accessible names; mobile drawer close is clear | Visible icon-only navigation and the generic material plus require learning; card opening needs a primary accessible target | UX-004, UX-012 |
| Consistency | Image/video share composer and viewer patterns; account tabs have explicit commits | Material/reference/asset terminology and mixed save rules require context switching | UX-004, UX-008, UX-017 |
| Feedback | Search no-match guidance is scoped; admin estimates are labeled; source has draft-replacement confirmations | Save feedback must reflect response success; status colors should identify evidence strength; raw historical errors need translation | UX-009, UX-010, UX-017 |
| Motion and focus | The mobile drawer settles correctly; Tab entered its content and Escape closed it | Initial animation screenshots are misleading; test final focus/position and reduced motion in a dedicated accessibility pass | UX-006, UX-012 |

Retain the dark cinematic presentation. Prioritize readable context and predictable controls before changing the palette, adding decoration or increasing animation.

## Prioritized roadmap

### Quick fixes: wording, labeling and information hierarchy

1. Improve reference/model/action language and identify output destination explicitly: UX-002, UX-003, UX-004, UX-017.
2. Associate admin labels; expose a keyboard Open action for media; tune essential text emphasis: UX-018, UX-012, UX-007. Card keyboard semantics may require more than a cosmetic patch.
3. Separate configuration-presence status from operational evidence and label report periods: UX-010, initial UX-011.

**Exit evidence:** a short newcomer walkthrough identifies task, destination and reference entry without explanation; an accessibility inspection names all affected controls. Actual testing with participants remains future work.

### Workflow improvements: confidence, preservation and retrieval

1. Make admin saves deliberate and response-verified together: UX-008 and UX-009. Keep HTTP-failure testing in an isolated environment.
2. Add configuration-aware estimates, per-mode settings preservation and compatibility explanations: UX-001, UX-005.
3. Improve responsive summaries, library density and retrieval filters: UX-006, UX-013.
4. Replace automatic first-record creation with clear empty states; move credential maintenance out of Overview: UX-016, remaining UX-011.

**Dependencies:** resolve which displayed amount represents internal cost versus customer billing before shipping UX-001; resolve state preservation before expanding iteration shortcuts. Confirm deployed behavior before implementing source-only findings.

**Exit evidence:** mode-switch and failed-save tests pass; no write occurs merely from visiting empty surfaces or tabbing through unchanged configuration; composer context is readable at all three viewport sizes.

### Larger product opportunities: production review and storytelling

1. Validate optional scene/shot/take metadata and source/continuation links: UX-014.
2. Prototype two-take comparison and approval states separately from quality flags: UX-015.
3. Validate an ordered handoff package and whether a shot-list/board pairing is more useful than a larger editing product.

**Exit evidence:** a director can find a candidate, compare it, identify its source and mark the production choice in a prototype study. Do not infer demand for a timeline editor or claim improved continuity quality from this audit alone.

## Sanitized browser evidence ledger

All entries refer to the September 7 inspection. B identifiers are reproducible observation references, not links to retained raw recordings. Customer prompts, email addresses, UUIDs and per-user spend have been omitted.

| ID | Route / action | Observed evidence and recheck |
| --- | --- | --- |
| B01 | `/`, initial and restored workspace | Video selected; empty prompt; Seedance 2.5; 16:9 / 1080p / 5s; project/root destination; assets collapsed; image history visible. Final return retained Video/model and an empty prompt; no composer edits performed. |
| B02 | `/`, open model picker then settings | Three video models: Seedance 2.0, Seedance 2.5, Gemini Omni Flash. Settings show Generate/Edit/Extend, aspect, resolution, duration slider, batch and audio; audio copy says billed on top. No numeric total estimate. Inspected menu and collapsed composer states; no model/settings selections made. |
| B03 | `/`, open destination and material menus | Project list and folder section; selected root labeled All assets, chip says All. Material offers upload, clip, library and disabled portrait entry. Menus dismissed without selection. |
| B04 | `/`, open assets → Videos → search → clear → All types → brief → All in project | Type filter settled to video results. Unique synthetic query returned “No matches” and a project/type-filter explanation; Clear search restored results. Brief editor opened without focus or edits. Search empty, All types and original project restored. |
| B05 | `/`, video-filtered library → completed video thumbnail | Viewer opened after a thumbnail click below overlay controls. Parameters, seed, two reference images, copy/expand prompt, frame reuse, continuation, clip reuse, Clone & try, same-seed regeneration and download present. No action executed. Historical failed cards showed Retry/Edit and raw provider error text. Viewer closed. |
| B06 | `/`, 1366 × 768, assets open | Dense library beside narrower composer; model label visible, several other chips collapsed to icons. Screenshot supports hidden-context finding, not a timing measurement. |
| B07 | `/`, 390 × 844 → assets drawer | Navigation icons replace text; model/folder names truncate. First screenshot caught drawer animation; settled recheck measured x=39 and width=351. Tab moved to project control; Escape closed drawer. Viewport reset and desktop assets collapsed. |
| B08 | `/admin`, Overview after loading | Recorded spend and average use estimate markers; reconciled/estimated breakdown; generation/user metrics and charts; credential-seeding form below reports. No values entered. Initial Loading state resolved. |
| B09 | `/admin`, Users | User/role/generation/cost/status/actions table; per-user role selectors and limits/reset/delete controls. No role or status changed; source confirms own-role protection. |
| B10 | `/admin`, Logs after loading | User/type/model/status filters, Flagged only, prompt search, CSV, paginated rows, separate Activity action/user filters. Settled “Showing 100 of …” and “Showing 50 of …” counters. A keyboard attempt to select failed did not establish an applied filter; All statuses was restored explicitly. No CSV export. |
| B11 | `/admin`, Pricing and Limits | Pricing model/unit/cents/notes table and future-only effect explanation; image/video scaling and audio surcharge copy. Limits show Max prompt length and Max concurrent jobs with global-default/user-override explanation. Inputs not focused. |
| B12 | `/`, account menu → Profile / Security | Profile has photo controls, Name, Email and disabled Save changes; Security has current/new/confirm password and disabled Change password. Both tabs settled before conclusions. Closed without input; keyboard Enter used to open admin navigation. |

## Local source evidence index

Relative file links are repository evidence; `#L` fragments indicate line locations for repository viewers. Source-only findings should be checked against the deployed revision before implementation.

| ID | Files / relevant implementation |
| --- | --- |
| S01 | [PromptComposer.jsx](../src/components/PromptComposer.jsx), [model-registry.js](../src/lib/model-registry.js), [config.js](../src/lib/config.js): model capabilities, controls, reference UI and available modes |
| S02 | [store.js — setMode/setModel](../src/lib/store.js#L314), [draft persistence](../src/lib/store.js#L1854): resets, capability adjustments and persisted composer state |
| S03 | [DetailModal.jsx](../src/components/DetailModal.jsx#L519), [iteration handlers](../src/components/DetailModal.jsx#L550), [media-action-confirmation.js](../src/lib/media-action-confirmation.js): seed, references, continuation and explicit mutation/billing copy |
| S04 | [ProjectPanel.jsx — BriefEditor](../src/components/ProjectPanel.jsx#L375): project brief save-on-blur, dirty/saving/saved states |
| S05 | [BoardSwitcher.jsx](../src/components/canvas/BoardSwitcher.jsx#L43), [CanvasView.jsx](../src/components/canvas/CanvasView.jsx#L68), [CanvasToolbar.jsx](../src/components/canvas/CanvasToolbar.jsx), [CanvasSurface.jsx](../src/components/canvas/CanvasSurface.jsx): auto-creation, save lifecycle, project context, desktop gate and spatial tools |
| S06 | [ChatSidebar.jsx](../src/components/ChatSidebar.jsx#L61), [StudioView.jsx](../src/components/StudioView.jsx), [StudioChat.jsx](../src/components/StudioChat.jsx#L80): conversation auto-creation, project/type scope and thread display |
| S07 | [DepthComposer.jsx](../src/components/DepthComposer.jsx), [TopBar.jsx](../src/components/TopBar.jsx): worker status, local depth input and navigation |
| S08 | [AdminDashboard.jsx](../src/components/AdminDashboard.jsx): Users role writes around lines 600/658; Logs filters around 1287; Pricing save around 1659; Limits save around 1758; accessibility labels in the same controls |
| S09 | [AdminDashboard.jsx — Status](../src/components/AdminDashboard.jsx#L1840), [backend status_checks.py](../backend/apps/admin_dashboard/status_checks.py#L40): mount-triggered checks, configuration-only provider results and aggregate summary |
| S10 | [AccountSettings.jsx](../src/components/AccountSettings.jsx#L413): labeled fields, read-only email, explicit profile/security commit controls |
| S11 | [HistoryPanel.jsx](../src/components/HistoryPanel.jsx#L143), [HomePage.jsx](../src/pages/HomePage.jsx#L140), [globals.css](../src/globals.css): search/filter structure, panel widths, mobile drawer and styling |
| S12 | [api.js](../src/lib/api.js#L9): fetch wrapper and separate response parser |
| S13 | [MediaCard.jsx](../src/components/MediaCard.jsx#L117): generic clickable card and separate overlay action controls |

## Verification and residual limits

- Rechecked loading versus settled states for Overview, Logs, history search, filtered history and the mobile drawer. Do not file the initial drawer animation position as a defect.
- Cross-checked high-priority source risks against their handlers and the fetch wrapper; no production failure or destructive workflow was induced.
- Browser observations and local source are explicitly separated. Generation quality, provider reliability, seed determinism, actual billing, completed editing, ordinary-user access and director workflow outcomes remain untested.
- Returned to the workspace with the desktop viewport restored, assets collapsed, original project selected, search cleared and All types restored. Video mode/model and empty prompt remained; model/settings/reference mutation controls were not activated. Scroll position changed during inspection and navigation.
- Repository delivery is this Markdown report only. Existing documents are preserved; no application, schema, public API or runtime implementation changes, commits or deployments are part of this audit.
