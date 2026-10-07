# Cutover gates

No production operation is authorized by local qualification alone. Before any
shared-target command, verify its actual target and obtain the documented
production authorization. The attached isolation requirement prohibits using
shared credentials for tests, workers, migrations or development commands.

1. Reconcile current worktree and deployed revision; preserve completed UI work.
2. Qualify isolated PostgreSQL 16 foundation, behavioral contracts and browser.
3. Prepare early Railway API service with explicit secrets, DB target, health,
   logs and same-origin method routing; review before deployment.
4. For each domain: parity, preview, authorized production canary, observation,
   authoritative transfer, rollback-window close, remove Node method.
5. Before schema takeover: fresh Django-only schema equivalence, actual catalog
   review, backup/PITR, safe migration-history baseline and verification.
6. Only after full Django HTTP API authority: split worker boundaries and qualify
   export then provider-by-provider generation workers with shadow/canaries.
7. Remove retired Node DB/provider dependencies and backend Vercel credentials.

Schema-changing final releases: backup/PITR, migration preflight, Django migration,
schema verification, API deployment, worker deployment, frontend deployment,
smoke checks and release verification. Migration failure blocks promotion.

All live evidence, release identities, rollback checks and secret-removal evidence
remain pending. See status.md and the original source-request.txt acceptance list.
