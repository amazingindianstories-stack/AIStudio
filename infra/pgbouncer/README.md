# PgBouncer

The transaction-mode connection pooler between every Veevee service and PostgreSQL. Why it exists, the per-service
connection budget and the rollout are in `docs/operations/database-connections.md` and
`docs/operations/release-runbook.md`.

| File | Purpose |
|---|---|
| `Dockerfile` | Debian trixie (digest pinned) with the distribution's PgBouncer 1.24. Build context is this directory: `docker build infra/pgbouncer`. `stage_railway_deploy.py <commit> pgbouncer` uploads exactly this directory. |
| `pgbouncer.ini.template` | The configuration. One database alias per service carries that service's server-connection budget and timeouts. `backend/config/db_profile.py` holds the same timeouts and a test keeps them equal. |
| `entrypoint.sh` | Renders the template from the service environment and runs PgBouncer in the foreground. |
| `auth.sql` | One-time setup in PostgreSQL: the `pgbouncer_auth` role and a restricted `SECURITY DEFINER` lookup, so PgBouncer verifies application roles against the live database instead of a password file. |

## Service variables (Railway, on the pooler service only)

| Variable | |
|---|---|
| `PGBOUNCER_UPSTREAM_HOST` | PostgreSQL private host (`<service>.railway.internal`) |
| `PGBOUNCER_AUTH_PASSWORD` | password of `pgbouncer_auth` |
| `PGBOUNCER_ADMIN_PASSWORD` | password of the `pgbouncer_admin` console user (`SHOW POOLS`, `RECONNECT`, `KILL`) |
| `PGBOUNCER_DATABASE_CA_PEM` | the pinned PostgreSQL CA the services already use |
| `PGBOUNCER_DATABASE_CA_SHA256` | optional: refuse to start unless the CA matches |
| `PGBOUNCER_UPSTREAM_PORT`, `PGBOUNCER_PORT` | optional, 5432 and 6432 |
| `PGBOUNCER_SERVER_TLS_MODE`, `PGBOUNCER_CLIENT_TLS_MODE` | optional, `verify-full` and `require` |

The pooler is reachable only on Railway's private network and gets no public domain.

## Changing a budget

Edit `pool_size` and `max_db_connections` of the alias together, update `docs/operations/database-connections.md`
and keep the sum of all aliases within the PostgreSQL budget derived there. `backend/config/test_db_profile.py`
fails when the template and the profile disagree.
