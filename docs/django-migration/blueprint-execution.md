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
