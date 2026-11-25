# Database connections (PgBouncer, budgets, observability)

Why Veevee puts a transaction-mode PgBouncer in front of PostgreSQL, how many server connections each service may
hold, and what keeps that true as the product grows. The rollout and rollback steps are in
[release-runbook.md](release-runbook.md#database-pooler-rollout-audit-deploy-stage).

## Decision

**A transaction-mode PgBouncer (`infra/pgbouncer`, Railway service `green-pgbouncer`) in front of PostgreSQL for
every service, with a fixed server-connection budget per service.** Raising `max_connections` alone was rejected,
and so was a pooler that is not under version control.

Evidence (production settings and activity read through the Railway CLI, read-only, no change made):

| Fact | Value |
|---|---|
| PostgreSQL | `green-postgres18`, `max_connections=30`, 3 reserved for superusers (27 usable) |
| Who connected | API, MCP, agent, export, scheduler, generation worker, all with an empty `application_name` |
| API | 1 gunicorn worker x 8 threads, `CONN_MAX_AGE=60`: up to 8 connections, mostly idle (17 idle connections seen in total) |
| Generation worker | one extra connection per running job for its lease heartbeat |
| Timeouts | no `statement_timeout`, no `idle_in_transaction_session_timeout` |
| Incident, 2026-11-24 | about 280 `too many clients` errors; the heartbeat then cancelled healthy generations (fixed in the interruption change) |

Why a pooler and not a bigger `max_connections`:

- The demand is connections held while idle, not work. A PostgreSQL backend is a process (about 10 MB plus `work_mem`
  per sort or hash node). Doubling `max_connections` doubles the idle cost and moves the cliff; it does not remove it.
  Every new API replica or worker slot would bring the incident back, and the next fix would be this redesign.
- With the pooler, clients (Django threads, up to 400) are cheap and only server connections are budgeted. A new API
  replica or worker slot adds clients, not backends, until its alias is deliberately given a larger pool.
- A full pool makes a client wait up to `query_wait_timeout` (15 s) and then fail with a retryable error. Exhaustion
  becomes back-pressure on one service instead of `FATAL` for all of them.
- Limits live in one place, one alias per service, so one service cannot starve another.

Why not a Railway-managed pooler: none is configured on `green-postgres18`, and a managed one would still not give
per-service budgets, per-service timeouts or configuration that is reviewed, tested and staged from this repository
(`scripts/release/stage_railway_deploy.py <commit> pgbouncer`).

## Sizing arithmetic

`max_connections` stays **30**.

| Item | Connections |
|---|---|
| `max_connections` | 30 |
| `superuser_reserved_connections` | 3 |
| Usable by roles | 27 |
| Pooler cap (sum of the alias budgets below: the most server connections it can ever open) | 18 |
| Left for direct connections (migrations, `psql`, a service temporarily on its direct URL, monitoring) | 9 |

The 9 spare connections are what makes rollback safe: a service that goes back to its direct URL needs at most its own
budget. The API is the largest and goes direct with 8 threads, so the runbook checks the headroom before rolling it back.

Memory: `shared_buffers` 64 MB, `work_mem` 4 MB, `maintenance_work_mem` 64 MB. Worst case with every usable slot
running two sort or hash nodes is 64 MB + 27 x (10 MB backend + 2 x 4 MB) = about 550 MB. The pooler's 18 server
connections alone are about 64 MB + 18 x 18 MB = about 390 MB. An idle backend costs only the 10 MB base. The instance
memory limit is a Railway plan setting that SQL cannot read; there is no reason to raise the number, because the pooler,
not `max_connections`, is what scales.

Scaling rule: the sum of every alias's `max_db_connections`, plus the 3 reserved, plus the direct headroom you want,
must stay at or below `max_connections`. To add a replica or a worker slot, raise that service's alias by its
concurrent database use (API: threads that are inside a transaction at the same time, not one per thread; generation:
running slots plus one for the shared heartbeat), and raise `max_connections` (and re-check memory above) only if the
sum no longer fits. `backend/config/test_db_profile.py` fails when the template and `backend/config/db_profile.py`
disagree or the sum exceeds 18.

## Per-service budget

One alias per service (`veevee_<component>`), each with its own pool and timeouts. `pool_size` equals
`max_db_connections`, so a pool never grows past its budget.

| Service (`application_name`) | Alias | Server connections | `statement_timeout` | `idle_in_transaction_session_timeout` | `CONN_MAX_AGE` pooled / direct |
|---|---|---|---|---|---|
| `veevee-api` | `veevee_api` | 7 | 30 s | 30 s | 600 s / 10 s |
| `veevee-mcp` | `veevee_mcp` | 2 | 30 s | 30 s | 600 s / 10 s |
| `veevee-agent` | `veevee_agent` | 2 | 30 s | 30 s | 600 s / 10 s |
| `veevee-generation` | `veevee_generation` | 4 | 60 s | 60 s | 600 s / 60 s |
| `veevee-export` | `veevee_export` | 1 | 120 s | 60 s | 600 s / 60 s |
| `veevee-scheduler` | `veevee_scheduler` | 1 | 120 s | 60 s | 600 s / 60 s |
| PgBouncer `auth_query` (role `pgbouncer_auth`) | `veevee_auth` | 1 | | | |
| **Total pooler cap** | | **18** | | | |

How the settings reach the server:

- **Direct connection** (`VEEVEE_DB_POOLER` unset, today's behavior): `application_name`, `statement_timeout` and
  `idle_in_transaction_session_timeout` go as startup options (`backend/config/db_profile.py`). The API, MCP and agent keep
  an idle connection for 10 s (it was 60 s).
- **Pooled connection**: the service never sends startup `options`. PostgreSQL does not report them back, so PgBouncer
  would apply the first client's values to every client sharing that server connection. The timeouts are set per alias
  with `connect_query`, and a test keeps them equal to `TIMEOUTS_MS`. PgBouncer tracks `application_name` per client, so
  `pg_stat_activity` still names the service that last used a server connection.
- Pooled Django sets `DISABLE_SERVER_SIDE_CURSORS=True`, `prepare_threshold=None` and a long `CONN_MAX_AGE` (a pooled
  client holds no server connection between transactions). PgBouncer's `max_prepared_statements=0` is the second line.
- Waits and backstops: a client waits `query_wait_timeout` 15 s for a server connection; PgBouncer reaches PostgreSQL
  within `server_connect_timeout` 5 s; `query_timeout` 180 s and `idle_transaction_timeout` 90 s catch a service whose
  own timeouts failed.

An alias is also a role boundary: clients log in with their own PostgreSQL role (the API role and the worker role
differ), PgBouncer verifies the password through `auth_query` against the live role (`infra/pgbouncer/auth.sql`, a
restricted `SECURITY DEFINER` lookup, so there is no password file to rotate), then logs in to PostgreSQL as that same
role. Pools are per (alias, role).

## TLS

Client to pooler uses `sslmode=require`: a per-start self-signed certificate encrypts Railway's private network hop.
Pooler to PostgreSQL uses `verify-full` with the pinned CA (`PGBOUNCER_DATABASE_CA_PEM`, optionally checked against
`PGBOUNCER_DATABASE_CA_SHA256`). Direct connections keep `verify-full` exactly as before. The tradeoff: a service
cannot verify the pooler's identity itself, so the guard is that `VEEVEE_DB_POOLER` must be a `*.railway.internal`
host:port (`backend/deploy/legacy_config.py` refuses anything else, because the role's password is sent to it) and the
pooler has no public domain.

## Pooler-safety audit

A transaction-mode pooler gives a server connection to another client between transactions. Anything that lives on one
PostgreSQL session is unsafe: session advisory locks, `LISTEN/NOTIFY`, server-side cursors, prepared statements,
session `SET`, temp tables. A transaction held open across slow I/O is also a pooler problem: it pins one of few server
connections, and the idle-in-transaction timeout kills it.

### Fixed in this change

| Site | Problem | Fix |
|---|---|---|
| `apps/assets/portrait_sync.py` `_sync_portraits` | session advisory lock `pg_try_advisory_lock(746833219)` held across network calls and commits; on a pooler the unlock can run on a different server connection and never release | database lease `lease:portrait-sync` (`apps.common.leases`, 300 s TTL, released in `finally`, expires by itself if the process dies) |
| `apps/media/uploads.py` `stream_local_chunk` | row lock and an open transaction held for a request body of up to minutes | lease `lease:upload-chunk:<session>` serializes writers; no transaction during the body read |
| `apps/media/uploads.py` `cancel_upload` | transaction held across the GCS cancel request and the object delete | three steps: mark `cancelling` under the row lock, do the storage calls with no transaction, end `cancelled`. A crash leaves `cancelling`, which a retry and `cleanup_expired_uploads` both resume; a storage failure puts the session back to its previous state (`uploading` or `verifying`). `finalize_upload` already holds no transaction across its object reads (two short transactions around the hash, with a `verifying` claim), so it needed no change; the cancel states are refused by it and by the chunk path |
| `apps/generation/services/executor.py` lease heartbeat | one thread and one connection per running job | `apps/generation/services/heartbeat.py`: one thread, one connection, one `UPDATE` renewing every owned lease, closed when the last job ends. Interruption semantics are unchanged: database errors are retried, a lease taken by another owner cancels that job at once, a lease unrenewable for a whole TTL cancels |
| Settings | server-side cursors, psycopg auto-prepare | `DISABLE_SERVER_SIDE_CURSORS` and `prepare_threshold=None` when pooled (covers the `.iterator()` calls in `exports/services.py`, `canvas/work_notifications.py`, `media/management/commands/backfill_thumbnails.py`) |

### Audited and safe as is

| Site | Why |
|---|---|
| `pg_advisory_xact_lock` in `apps/mcp_auth/controls.py`, `projects/services/projects.py`, `agents/limits.py`, `agents/grants.py`, `library/services/idempotency.py`, `canvas/ai_allowance.py`, `assets/managed_pool.py`, `generation/services/admission.py` | transaction-scoped: taken and released inside one transaction, which stays on one server connection |
| `SET LOCAL transaction_read_only = on` in `apps/common/middleware.py` (maintenance write freeze) | `SET LOCAL` ends with its transaction |
| `apps/common/leases.py` | plain rows in `settings`, claimed, renewed and released by single statements |
| `LISTEN`, `NOTIFY`, temp tables, `DECLARE` cursors, session `SET` | none in `backend/` (searched) |

### Accepted, bounded transactions

| Site | Why it stays |
|---|---|
| `apps/media/uploads.py` `initialize_upload`: `begin_reference_upload` (creates a GCS resumable session) inside the actor-lock transaction | one short HTTP call per upload, bounded by the API's 30 s idle-in-transaction limit; moving it out would need a second state for a half-created session |
| Higgsfield `persist_rotation` (token rotation write) | a single short write |

If a new feature genuinely needs a session (a long cursor, `LISTEN`, a session lock), connect it directly with its own
small budget out of the 9 spare connections and record it here. Do not put session state behind the pooler.

## Observability

- `apps.common.db_usage.snapshot()` reads `max_connections`, the reserved counts and `pg_stat_activity`
  (`backend_type='client backend'`) grouped by `application_name`; it calls `pg_stat_clear_snapshot()` first because
  PostgreSQL caches activity inside a transaction. Rows of other roles appear as `(other roles)` unless the API role
  holds `pg_read_all_stats`; the total is always exact.
- **Admin status**: the `db-connections` check (`apps/admin_dashboard/status.py`) is `ok` with the per-service split and
  turns to `error` at 80% of usable connections (`WARN_RATIO`).
- **Logs**: the scheduler logs a warning on `veevee.maintenance` every 60 s while usage is at or above 80%
  (`db_connections` handler in `apps/workers/scheduler.py`). Alert on that line.
- **Pooler**: from the admin console (`pgbouncer_admin`): `SHOW POOLS` (`cl_waiting` above 0 for more than a few seconds
  means a pool is too small), `SHOW STATS`, `SHOW CLIENTS`. PgBouncer also logs its statistics once a minute.

## Load test

`scripts/dev/pooler-load-test.py` runs the real `infra/pgbouncer/entrypoint.sh` (so the real template, aliases and
`connect_query` timeouts) in front of a scratch PostgreSQL with `max_connections=30`. Docker is not needed, and it was
not available when this was written. It drives 200 API-style clients, the other services and 12 running jobs with
heartbeats while sampling `pg_stat_activity`, then sends the same clients straight at PostgreSQL as a control. A last
phase runs Django itself through the pooler (settings profile, leases, iterators, advisory transaction locks, one shared
heartbeat connection for 12 jobs). It needs `pgbouncer`, `envsubst` and `openssl` on `PATH`, a migrated database with
the roles granted, and the Django settings environment of `scripts/dev/test-db.sh`:

    python3 scripts/dev/pooler-load-test.py --pg-port 54390 --database railway \
        --api-password ... --worker-password ... --auth-password ... [--seconds 15] [--clients 200]

It prints `OK` only if the pooled run has no errors and never holds more backends than the budget, and the control run
does hit the limit (so the test can fail). It touches no deployed database. A recorded run: 8496 operations with 0
errors and a peak of 18 backends held by the application roles, against 9252 refused connections in the control. The
production image ships PgBouncer 1.24 (Debian trixie); the local run used 1.26. Every setting the configuration relies on
(`max_prepared_statements`, per-database `connect_query`, `auth_query`) exists in 1.24.
