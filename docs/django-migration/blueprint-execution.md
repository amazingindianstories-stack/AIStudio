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
