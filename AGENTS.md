# Repository operating rules

## Public repository

The GitHub repository is public. Never commit credentials, connection strings, private
hostnames, provider account URLs or customer media. Credential-bearing files stay in the owner's
private root outside Git. Commit locally; push, merge and deploy only with owner approval.

## Output quality

Prioritize production master quality. Seedance 2.5 Generate, Edit, Extend, Draft
and draft-to-final requests must request native MOV (`output_format: "mov"`) and
preserve original bytes through storage and downloads. Final and High bitrate
are the normal defaults. Respect explicit resolution, Draft, bitrate and audio
choices; ask before changing settings that materially increase cost. Never
rename an MP4 to MOV, recompress a master, or lower master quality for browser
preview compatibility.

## Backend authority

Django/DRF under `backend/` owns API behavior, providers, persistence and workers
(`docs/architecture/ADR-django-authoritative-backend.md`). Next.js is a frontend with
same-origin `/api` transport. New backend functionality and schema changes belong in Python
and the single managed Django migration graph under `backend/apps/*/migrations`.

Do not restore Node business routes, Drizzle schema ownership, or a browser-driven
generation executor. Historical source outputs under `backend/testsupport/goldens/`
are inert comparison evidence, not an executable second backend. Keep provenance
and output hashes when updating goldens.

## Test isolation

Tests, Django commands, migrations, servers and workers run only against disposable
PostgreSQL with explicit mock providers and storage. Never load shared checkout credentials,
personal cloud credentials or an inherited `DATABASE_URL`. `scripts/dev/test-db.sh` supplies a
throwaway PostgreSQL 18.6 and an allowlisted environment; the release gate runs the suite inside
the production image. Synthetic results never stand in for live provider acceptance.

## Database changes and releases

Schema changes require reviewed Django migrations, a fresh-database test and an
upgrade test from the previous supported migration state. Prefer additive,
backward-compatible changes; expand schema, deploy compatible code, and clean up
only in a later reviewed release. Preserve indexes, defaults, foreign keys,
triggers, row-level security, naming counters and data invariants, not merely
model columns. App labels, migration names and `db_table` names are recorded in
production; moving a model between apps needs a state-only migration.

`backend/deploy/legacy_config.py` refuses to start when the production migration
count is not one it expects (`MIGRATION_ROWS`); a release that adds a migration
updates it in the same commit. Vercel builds, Django image startup and worker
startup never migrate the database. A controlled migration release must finish
and pass verification before code relying on the new shape is promoted.

Every backend deploy needs `scripts/release/release_gate.sh` and
`scripts/release/rehearse_local.sh` passes for the exact commit and explicit owner
approval, and follows `docs/operations/release-runbook.md`. Record the result in
`docs/operations/status.md`.

## Upload and draft contracts

Django upload init/status/finalize/cancel owns metadata and authorization. Browser
large-file chunks go directly to native resumable GCS; filesystem tests use the
authenticated local chunk endpoint. READY reference IDs are durable and
actor-checked. Expired-upload cleanup excludes READY and shared originals.
`LOCAL_DATA_MODE=read_only_viewer` rejects write verbs, read-triggered writes and
writer CLI startup; it still requires a separately verified authorized reader.
Draft metadata is actor/project-scoped with occurrence IDs; no binary or bearer
URL persistence.

## Deployment origins

For every authorized Preview deployment, verify its actual Vercel project,
target and hostname, then reconcile that exact HTTPS origin with Green's Django
browser/CSRF origin configuration before handing over the URL. Preserve existing
authorized origins and unrelated configuration. Verify real browser login and a
CSRF-protected request; a READY frontend build alone does not establish integration.
Never fix a forbidden-origin error with wildcard origins, disabled CSRF checks,
client-supplied ingress credentials or a fallback to Blue.

Production releases get the same verification for the exact Production domains
and aliases. Record origin reconciliation and authentication evidence alongside
the deployment receipt.
