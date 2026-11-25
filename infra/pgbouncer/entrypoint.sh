#!/bin/sh
# Render the PgBouncer configuration from the service environment and run PgBouncer in the foreground.
#
# Required variables (Railway service variables on the pooler service; values are never printed):
#   PGBOUNCER_UPSTREAM_HOST          PostgreSQL private host, e.g. green-postgres18.railway.internal
#   PGBOUNCER_AUTH_PASSWORD          password of the pgbouncer_auth role (see auth.sql)
#   PGBOUNCER_ADMIN_PASSWORD         password for the pgbouncer_admin console user (SHOW POOLS, KILL, RECONNECT)
#   PGBOUNCER_DATABASE_CA_PEM        the pinned PostgreSQL CA the application already uses (VEEVEE_DATABASE_CA_PEM)
# Optional: PGBOUNCER_UPSTREAM_PORT (5432), PGBOUNCER_PORT (6432), PGBOUNCER_SERVER_TLS_MODE (verify-full),
#           PGBOUNCER_CLIENT_TLS_MODE (require), PGBOUNCER_DATABASE_CA_SHA256 (fail closed unless the CA matches).
set -eu
umask 077

: "${PGBOUNCER_UPSTREAM_HOST:?PGBOUNCER_UPSTREAM_HOST is required}"
: "${PGBOUNCER_AUTH_PASSWORD:?PGBOUNCER_AUTH_PASSWORD is required}"
: "${PGBOUNCER_ADMIN_PASSWORD:?PGBOUNCER_ADMIN_PASSWORD is required}"
export PGBOUNCER_UPSTREAM_PORT="${PGBOUNCER_UPSTREAM_PORT:-5432}"
export PGBOUNCER_PORT="${PGBOUNCER_PORT:-6432}"
export PGBOUNCER_SERVER_TLS_MODE="${PGBOUNCER_SERVER_TLS_MODE:-verify-full}"
export PGBOUNCER_CLIENT_TLS_MODE="${PGBOUNCER_CLIENT_TLS_MODE:-require}"

RUNTIME="$(mktemp -d /tmp/pgbouncer-XXXXXX)"
export PGBOUNCER_TLS_DIR="$RUNTIME"
export PGBOUNCER_AUTH_FILE="$RUNTIME/userlist.txt"

if [ "$PGBOUNCER_SERVER_TLS_MODE" != "disable" ]; then
    : "${PGBOUNCER_DATABASE_CA_PEM:?PGBOUNCER_DATABASE_CA_PEM is required unless PGBOUNCER_SERVER_TLS_MODE=disable}"
    printf '%s\n' "$PGBOUNCER_DATABASE_CA_PEM" > "$RUNTIME/database-ca.pem"
    if [ -n "${PGBOUNCER_DATABASE_CA_SHA256:-}" ]; then
        actual="$(openssl x509 -in "$RUNTIME/database-ca.pem" -outform DER | openssl dgst -sha256 | sed 's/^.* //')"
        [ "$actual" = "$PGBOUNCER_DATABASE_CA_SHA256" ] || { echo 'pgbouncer: database CA does not match the pinned certificate' >&2; exit 1; }
    fi
else
    : > "$RUNTIME/database-ca.pem"
fi

# Clients reach the pooler over Railway's private network; the certificate only encrypts that hop and is generated
# per container start (the application then connects with sslmode=require).
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj '/CN=veevee-pgbouncer' \
    -keyout "$RUNTIME/server.key" -out "$RUNTIME/server.crt" >/dev/null 2>&1

# auth_file holds only the two service users; application roles are verified through auth_query.
{
    printf '"pgbouncer_auth" "%s"\n' "$(printf '%s' "$PGBOUNCER_AUTH_PASSWORD" | sed 's/"/""/g')"
    printf '"pgbouncer_admin" "%s"\n' "$(printf '%s' "$PGBOUNCER_ADMIN_PASSWORD" | sed 's/"/""/g')"
} > "$PGBOUNCER_AUTH_FILE"

envsubst < "${PGBOUNCER_TEMPLATE:-/etc/pgbouncer/pgbouncer.ini.template}" >"$RUNTIME/pgbouncer.ini"
exec pgbouncer "$RUNTIME/pgbouncer.ini"
