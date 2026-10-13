# Local implementation blueprint execution

Authority: `Veevee_Django_Migration_Blueprint_2026-10-08.md` supersedes the
previous production-cutover goal for this run. Implement and qualify the full
Django/Python replacement locally. No deployment, push/merge to main, shared DB
access, live provider/cloud calls, production migration or live secret changes.
Production ownership remains separately recorded and must not be inflated by
local implementation progress.

## G0 source reconciliation

Created local branch `migration/django-blueprint-2026-10-08` from checkpoint
`89b032298c31a44fee0d2745989f630341bcf181`. Compared all 791 source files in the
handoff archive manifest: zero missing files and zero hash differences. Preserve
and commit its existing Asset Library changes together with the supplied
blueprint, without adding excluded runtime data, credentials or review media.

Already recorded release evidence identifies Vercel deployment
`dpl_Aw9qb3spGS9jswTZijRXen4Dt4ex`, reporting commit
`a208e8aee3c6aa052a9482f996235e4992618a8b`. This is historical evidence from
`frontend-deployment-evidence.json` and `railway-api-release.md`, not a new live
inspection and not proof the present source matches deployed production.

Folder-colour CI integration, old-schema upgrade coverage and a clean-checkout
qualification run remain G0/G1 work. Preserve every explicit gate G0–G9 in the
blueprint; this reconciliation is not migration completion.

## Working sequence

1. Reconcile source and folder-colour migration, then qualify clean source.
2. Consolidate one managed Django graph; retain source/reference evidence and
   reject-by-default history-only adoption tests without touching shared DBs.
3. Complete security/media/auth primitives and all 85 HTTP contracts.
4. Replace generation/export workers, providers, depth/callback/scheduler work.
5. Route local browser and worker integration solely to Django, remove Node
   business dependencies after replacement tests, and run the full acceptance
   matrix before packaging the undeployed source and deployment-only playbook.

## G0 integration evidence

Folder-colour migration is now included in database and browser CI. The legacy
schema verifier requires its check constraint; the existing admin migration
installs and verifies it with a separate expected count. Exact-content Node
exceptions are scoped to `DJANGO-BLUEPRINT-G0`; no general Node feature exception
is granted. The admin API inventory hash reflects this reconciliation.

Fresh disposable PG18 qualification passed four tests: admin authentication,
repeat migration success, injected transaction rollback, and a populated
pre-colour schema upgrade with eight palette values, NULL default, preservation,
repeatability and invalid-value rejection. The earlier reused database had an
orphan fixture and correctly failed FK installation; it was not repaired or used
as positive evidence. Full test output is in `evidence/g0-admin-color-tests.log`.
Ownership/contract and generated-status guards pass. Three missing history GET
contract dimensions were completed from its documented behavior; chronological
schema updates were moved out of the generated status into status-history.md.

Read-only delegated audit confirmed 65 files/85 methods and only 12 currently
implemented Django methods. Stable acceptance identity is method plus path:
issue numbers are reused. Project POST includes folder operations; profile PATCH
needs media storage; browser store.js also invokes queue/execute; coordinator
bootstrap starts the export worker. These dependencies must survive the planned
service split and be removed only after replacement qualification.

Detached clean source checkout `b2aa5df` passed PG16 committed fresh/adoption
qualification, PG18 executor catalog equivalence, all 1,069 Node unit tests,
ESLint and the Next production build. Installed Node dependencies were reused;
no clean `npm ci` claim is made. Evidence and complete sanitized logs are under
`evidence/g0-*`. No shared service was accessed. G1 now consolidates the two
Django graphs and replaces partial-table test fixtures with migrated-schema tests.

## G1 active managed graph and ongoing API work

The sole active migration graph now contains 21 CreateModel operations and one
invariant RunSQL migration; all 21 runtime models are managed. The old 49-record
state-only graph is retained as hashed history evidence, not executable source.
PostgreSQL 16.15 fresh creation and rich populated adoption passed. All 21
application tables contained data (40 rows total); adoption preserved rows and
49 historical records, added 22 records without application DDL, and was a no-op
after reconnect/repeat. Missing index/trigger, different default and unknown
history all rejected. Exact PG18 catalog comparison and all 42 existing Django
tests also passed. Index/default/check probes passed again after consolidation.
Evidence is under evidence/veevee-g1-* and evidence/veevee-pg16-baseline-evidence.json.
The registry is generated as model-registry.md.

The user briefly requested a pause ZIP (1,810,328 bytes), then explicitly resumed
the full goal and requested no checkpoint stops. The ZIP is historical. Current
work continues with profile/auth foundations and independent Canvas/library/media
workstreams. Integration routing/schema ownership stays with the parent agent.
No production ownership, adoption or deployment has occurred. Concurrent domain
invariants and full endpoint/worker/browser gates remain in progress.

## G2–G9 final local completion

All 85 methods are implemented or intentionally retired, Python providers/workers
replace the Node backend, and all 346 retirement files are absent. Final qualification
passed 340 Django tests on PG16,397 frontend tests,50 browser cases, lint/build,
14 tooling tests and PG16/18 catalog equivalence. See qualification-index.md and
completion-audit.md for exact evidence and boundaries. Source remains uncommitted
and undeployed; production adoption and all live acceptance remain pending.
