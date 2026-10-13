# Django migration qualification — completed local implementation

The local undeployed branch implements the blueprint's Django backend and Python
workers. Production ownership remains unchanged and unverified. This page
supersedes qualification-history-before-blueprint.md.

| Gate | Authoritative local evidence |
|---|---|
| Full Django suite | 340 tests passed on Python 3.12, PostgreSQL 16.15, native libvips and FFmpeg; final container log |
| Fresh schema | 22 migrations; exact frozen catalog equivalence: 21 application tables/205 columns plus Django bookkeeping |
| Populated adoption | 40 rows across all 21 tables preserved; 49 old +22 new history records; zero application DDL; reconnect/repeat no-op; four drift/history cases rejected |
| PostgreSQL 18 scratch | Active migration executor exact catalog match; both invariant fixtures pass and scratch DDL rolls back |
| API inventory/security | 85 declared methods resolve; 307 negative HTTP requests cover absent/forged/revoked credentials and hostile origins with zero mutations/remote effects |
| Frontend | Clean npm ci; 397 tests pass; lint and Next15.5.27 standalone build pass; 96-module runtime import boundary |
| Browser | All 50 Chromium cases pass through Django Gunicorn and independent Python generation/export workers; Node handlers prohibited |
| Tooling | 14 migration/release/CI isolation tool tests pass; makemigrations dry-run reports no changes |
| Security/performance | Immutable completion objects, active-session media checks, private export ownership/TTL, bounded JSON, receipt recovery, shutdown cancellation; keyset bounded index scan |
| Dependency audit | Zero runtime npm vulnerabilities; build tooling findings retained in full audit evidence, without a forced major Tailwind migration |
| Retirement | 346 hashed files removed, including 65 Next handlers, Node workers/provider/DB code and Drizzle authority; nine UI runtime direct dependencies remain |

Complete logs, JSON artifacts and their hashes are in `evidence/g8-final/`.
The API image fingerprint is `34cdaf99c8618c55a0a3e19246dea0d76145583f90318e4058ca5f5838ae140c`.
It identifies the tested uncommitted backend bytes; the Git base alone does not.
The local method matrix is in local-implementation.json and status.md. Exact
models, defaults, indexes, checks and FK ownership are in model-registry.md.
Seven-provider and auxiliary coverage/live limits are in provider-parity-matrix.md.

## Reproduction

On macOS prepare a fresh session with `python3 scripts/django-migration/isolated.py
prepare`, then `start-db SESSION`. Prefix commands with `isolated.py run SESSION`.
Install backend requirements into an isolated venv, and use its Python executable.
Never load checkout environment files. The runner verifies the actual dedicated
cluster and supplies mock flags and an empty credential home.

- `PYTHON scripts/django-migration/container-build.py --runtime --declared-schema --invariants --baseline --tests` qualifies production-style Python/PG16, schema/adoption, full suite and cleans ephemeral containers.
- `PYTHON backend/manage.py test apps.common apps.admin_dashboard apps.library apps.assets apps.authentication apps.projects apps.canvas apps.agents apps.generation apps.exports apps.workers apps.media testsupport --noinput` runs the complete labeled suite. Unlabeled discovery from the repo root is insufficient.
- `PYTHON backend/manage.py makemigrations --check --dry-run` and `PYTHON -m unittest discover -s scripts/django-migration -p 'test_*.py'` verify graph/tooling.
- `PYTHON scripts/django-migration/schema-reproduction-probe.py --migration-executor --require-equivalent` verifies the PG18 scratch catalog.
- `npm ci`, `npm test`, `npm run lint`, `npm run build`, `npm run check:backend-ownership`, `npm run check:migration-status`, `npm audit --omit=dev` verify the frontend without credentials.
- `PYTHON scripts/django-migration/browser-harness.py --install-browser` starts the isolated API/frontend/workers and executes all browser cases, then cleans child processes.

GitHub-hosted Linux CI uses ci-qualification.py to inspect its PG16 service
identity/network/port/tmpfs before qualification. Guard tests pass; the actual
GitHub workflow is UNEXECUTED because no branch was pushed. The full local
container/browser results above are the executed aggregate evidence.

## Operational limits

No production target, provider account, cloud storage, deployment or Git remote
was accessed. Package registries supplied dependencies. Live provider entitlement,
OAuth/IAM signing, CDN/CORS, hosted TLS proxy behavior, GPU inference and production
schema/history audit remain the separately authorized cutover's acceptance gates.
See the UNEXECUTED cutover-runbook.md. A remote acceptance/crash before a durable
receipt remains ambiguous; taskless uncertain jobs are never automatically
resubmitted. Losing immutable uploads may leave orphan objects requiring reviewed
age/reference cleanup. Neither exactly-once external billing nor live compatibility
is inferred from mocks.
