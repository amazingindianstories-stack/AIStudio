# Decision Log — Admin API Status Page

Each entry: decision, alternative rejected, why.

## D1 — Scope of "all APIs" = 4 generation providers + Postgres + S3
**Decision**: Check Gemini/NBP, Higgsfield MCP, BytePlus/Seedance, Omni Flash, Postgres, S3.
**Rejected alternative**: Only the 4 generation providers (literal reading of "apis").
**Why**: An admin status page is more useful if it also surfaces "DB down" / "storage
unreachable" — those are equally load-bearing dependencies and equally opaque today.
No user round-trip needed; low-risk default, easy to narrow later if unwanted.

## D2 — Manual refresh only, no auto-polling
**Decision**: Status checks run on tab-open and on manual "Refresh" click only.
**Rejected alternative**: Background auto-refresh every N seconds.
**Why**: Several checks call paid/rate-limited external APIs; an admin tab left open
with auto-polling would generate continuous background load/cost for no benefit over
on-demand checks. Matches the literal request ("a refresh status" — singular action).

## D3 — No persistence of check history
**Decision**: Results are live/ephemeral only, not written to Postgres.
**Rejected alternative**: Store each check run for an uptime history view.
**Why**: Out of stated scope ("see the status... and a refresh"); adding a table +
retention policy is a meaningfully bigger feature. Deferred as a clean future extension.

## D4 — Default per-check timeout: 5 seconds
**Decision**: Each dependency check races a 5s timeout; on timeout the row reports
"Unknown/timeout" rather than hanging.
**Rejected alternative**: No timeout (rely on each SDK's own default, which for some
providers can be 30s+).
**Why**: Acceptance criterion 4 (one hung dependency must not block the page) requires
an explicit bound; 5s is generous enough for a real auth/metadata call, tight enough to
keep the page feeling responsive.

## D5 — Stage 1 gate: design.md + ui-spec.md APPROVED, with three reconciliations

Reviewed both artifacts against spec.md's 10 acceptance criteria (design.md's own §9
mapping checks out), the file plan (minimal: one new lib module, one new route, a
2-line Higgsfield export change, four localized edits to `AdminDashboard.tsx` — nothing
surprising), and the Higgsfield D0 constraint (design.md §6.2/§12-R1 is airtight: only
`loadToken()`+`isFresh()`, explicit grep-for-zero-hits instruction for security review).
No reservations large enough to send back to the architect. Found three small
inconsistencies between design.md's frontend contract (§8, written by the architect as
a secondary concern) and ui-spec.md (the authoritative visual contract) — resolved here
rather than another round-trip:

1. **First-load state**: design.md §8 describes a single blank "Loading…" placeholder;
   ui-spec.md §5 specifies six skeleton rows with per-row "Checking…" spinners.
   **Resolved: ui-spec.md wins** (better UX, explicitly justified — names are static and
   known up front, so showing all six rows immediately is strictly more informative than
   a blank state). Implementer follows ui-spec.md §5, not design.md §8's placeholder line.
2. **Latency column**: design.md §8 lists a "Latency (`{latencyMs} ms`)" table column;
   ui-spec.md's table has only four columns (Dependency/Status/Detail/Last checked), no
   latency column. **Resolved: ui-spec.md wins** (no latency column rendered). The API
   still returns `latencyMs` on every `CheckResult` (design.md §3) — harmless to keep in
   the type/response even though the UI doesn't surface it as its own column; a future
   iteration could add it without an API change.
3. **Display name wording**: design.md's registry table (§4) names the sixth check
   "S3 Media Storage"; ui-spec.md's fixed row list (§2) says "S3 storage". **Resolved**:
   the frontend renders the API's `CheckResult.name` field directly (per design.md §8,
   "Columns: Dependency (name)") rather than a separately hardcoded label list, so there
   is one source of truth. Canonical wording: use design.md §4's registry table verbatim
   (`"S3 Media Storage"`, `"Gemini / Nano Banana Pro"`, etc.) since that's what the API
   actually returns — ui-spec.md's near-identical list was descriptive, not meant to
   fork from the API's name field.

None of these affect data model, the Higgsfield safety constraint, or any acceptance
criterion. Logged rather than re-looped per the pipeline's "send back once if not"
gate rule — a second design round would cost more than adjudicating three small
wording/UX reconciliations directly.

## D6 — Stage 3 review adjudication (code-reviewer + security-reviewer + ui-designer Mode 2)

All three reviewers ran clean: code-reviewer found 3 MINOR issues (no CRITICAL/MAJOR),
security-reviewer found nothing above LOW (and judged the one LOW — no rate limiting on
the route — an acceptable risk for an admin-only, low-frequency tool, not worth fixing),
ui-designer Mode 2 live-reviewed the rendered page in a real browser and returned PASS
with 2 MINOR findings. Adjudicated:

1. **Fixed** — summary line read "Running checks…" during a first-load failure (contradicts
   the red error notice sitting right below it). `AdminDashboard.tsx`: summary now reads
   "Status check failed" when `checkedAt === null && error` is set.
2. **Fixed** — `checkSeedance`/`checkOmni` were flagged by design.md §13 as "purely
   unit-testable" pure env-var mappings but had no automated coverage because they weren't
   exported. Exported both from `status-checks.ts`; added the 5 documented test cases to
   `status-checks.test.ts` (22/22 passing total, up from 17).
3. **Rebutted, no code change** — timeout detail string could theoretically read as an
   abort message instead of "Timed out after Nms" if `AbortController`'s rejection raced
   ours. Code-reviewer's own analysis showed `reject(new TimeoutError())` runs
   synchronously in the same callback and wins the race in practice; status is `"error"`
   either way regardless of wording. Not worth adding ordering guarantees for a cosmetic
   detail string.
4. **Fixed (docs only)** — ui-spec.md §2's display-name list (`Gemini · Nano Banana Pro`,
   `BytePlus · Seedance`, `S3 storage`) drifted from the canonical names design.md §4 and
   the shipped code actually use (`Gemini / Nano Banana Pro`, `BytePlus ModelArk /
   Seedance`, `S3 Media Storage` — the D5 reconciliation already decided the API's `name`
   field is the single source of truth). Updated ui-spec.md to match reality rather than
   changing the (correct) shipped names.
5. **No action** — UI reviewer's second MINOR was an observation, not a defect (the
   "Running checks…" summary during first-load failure was covered by fix #1 above; the
   reviewer flagged it as low-priority/borderline before I'd applied that fix).

Both fixes verified: `npx tsx --test src/lib/status-checks.test.ts` → 22/22 passing;
`npm run build` → clean. No second review round needed — both fixes are small, isolated,
and directly implement what the reviewers asked for.

## D0 — Higgsfield check must never refresh the token (carried over as a hard constraint, not a discretionary decision)
Per prior incident: Higgsfield refresh tokens are single-use and reuse revokes the whole
token family, with no automated recovery. The health check may only report presence /
cached-token validity; it must never attempt a refresh-token exchange as part of a
"check if healthy" action. This is written into spec.md as a hard constraint and will be
specifically checked in the design gate and security review, not treated as a normal
adjudicated finding.
