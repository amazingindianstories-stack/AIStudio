# Repository operating rules

## Output quality

Prioritize production master quality. Seedance 2.5 Generate, Edit, Extend, Draft
and draft-to-final requests must request native MOV (`output_format: "mov"`) and
preserve original bytes through storage and downloads. Final and High bitrate
are the normal defaults. Respect explicit resolution, Draft, bitrate and audio
choices; ask before changing settings that materially increase cost. Never
rename an MP4 to MOV, recompress a master, or lower master quality for browser
preview compatibility.

## Backend and schema authority

`Veevee_Django_Migration_Blueprint_2026-10-08.md` and
`docs/architecture/ADR-django-authoritative-backend.md` govern this branch.
Django/DRF under `backend/` owns local API behavior, providers, persistence and
workers. Next.js is a frontend with same-origin `/api` transport. New backend
functionality and schema changes belong in Python and the single managed Django
migration graph under `backend/apps/*/migrations`.

Do not restore Node business routes, Drizzle schema ownership, or a browser-driven
generation executor to fix parity failures. Historical source outputs under
`backend/testsupport/goldens/` are inert comparison evidence, not an executable
second backend. Keep provenance and output hashes when updating goldens.

Local authority is distinct from deployed ownership. The production history in
`docs/django-migration/route-ownership.yaml` remains unchanged until a separately
authorized cutover is actually executed and verified. This implementation goal
does not authorize shared database access, provider/cloud calls, deployment,
push, merge, or production migration.

## Qualification isolation

Before tests, Django commands, migrations, servers or workers, verify actual
targets without printing credentials. Use disposable PostgreSQL and explicit
mock providers/storage. Never load shared checkout credentials or personal cloud
credentials for qualification.

- Local macOS: `scripts/django-migration/isolated.py` prepares a clean source copy,
  empty credential home, allowlisted environment and a dedicated loopback cluster.
- GitHub-hosted Linux: `scripts/django-migration/ci-qualification.py` inspects the
  job service container identity, PostgreSQL 16 image/live version, job network,
  published port and tmpfs data mount before database qualification. A flag or
  environment-variable name alone is not target verification.
- Run the full Django suite, including `apps.media`, and the Django browser
  harness. Frontend tests/lint/build run without backend credentials.
- Live-provider acceptance is separate evidence; synthetic qualification must
  never be described as a live provider result.

## Database changes and releases

Schema changes require reviewed Django migrations, a fresh-database test and an
upgrade test from the previous supported migration state. Prefer additive,
backward-compatible changes; expand schema, deploy compatible code, and clean up
only in a later reviewed release. Preserve indexes, defaults, foreign keys,
triggers, naming counters and data invariants, not merely model columns.

For populated legacy databases, ordinary `CreateModel` migrations are unsafe.
Require an actual catalog/history audit, backup/PITR, exact equivalence and row
preservation before reviewed history-only baseline adoption. Never use blind
`--fake-initial`. The disposable adoption probes are not production tools.

Vercel builds, Django image startup and worker startup must not migrate the
database. A controlled migration release must finish and pass verification before
code or workers relying on the new shape are promoted. Preserve native media,
organization IDs/scopes and frozen export names. Follow
`docs/django-migration/cutover-runbook.md`; every live step remains UNEXECUTED
until its release evidence is recorded.

## Goal 2 local contracts

Django upload init/status/finalize/cancel owns metadata and authorization. Browser
large-file chunks go directly to native resumable GCS; isolated filesystem tests
use the authenticated local chunk endpoint. READY reference IDs are durable and
actor-checked. Expired-upload cleanup excludes READY and shared originals.
`LOCAL_DATA_MODE=read_only_viewer` rejects write verbs, read-triggered writes and
writer CLI startup; it still requires a separately verified authorized reader.
Draft metadata is actor/project-scoped with occurrence IDs; no binary or bearer
URL persistence. Goal 2 local qualification does not authorize hosted acceptance.

## Deployment origins

For every authorized Preview deployment, verify its actual Vercel project,
target and hostname, then reconcile that exact HTTPS origin with Green's Django
browser/CSRF origin configuration before handing over the URL. Preserve existing
authorized origins and unrelated configuration. Verify real browser login and a
CSRF-protected request; a READY frontend build alone does not establish integration.
Never fix a forbidden-origin error with wildcard origins, disabled CSRF checks,
client-supplied ingress credentials or a fallback to Blue.

During a separately approved Production cutover, perform the same verification
for the exact Production domains and aliases. This rule does not authorize
Production changes or promotion. Record origin reconciliation and authentication
evidence alongside the deployment receipt so the check is repeated automatically
as part of each release procedure.
