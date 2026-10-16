#!/bin/sh
# First start of the local database only: restore the Green copy with its roles,
# RLS policies and ledger functions, then give the roles local-only passwords.
set -eu
GLOBALS=$(ls /seed/green-globals-*.sql | head -1)
DUMP=${VEEVEE_SEED_DUMP:-$(ls -t /seed/green-*.dump | head -1)}
echo "restoring roles from $(basename "$GLOBALS") and data from $(basename "$DUMP")"
grep -E '^(CREATE|ALTER) ROLE ' "$GLOBALS" | grep -v 'ROLE postgres' | psql -v ON_ERROR_STOP=1 -U postgres -q
psql -v ON_ERROR_STOP=1 -U postgres -q -c "CREATE DATABASE railway"
# Keep owners: ledger functions run with their owner's rights; RLS policies name the real roles.
pg_restore -U postgres -d railway --exit-on-error "$DUMP"
psql -v ON_ERROR_STOP=1 -U postgres -q -c "ALTER ROLE goal4_green_preview_api LOGIN PASSWORD '$API_DB_PASSWORD'; ALTER ROLE goal4_green_preview_worker LOGIN PASSWORD '$WORKER_DB_PASSWORD';"
echo "local Green copy ready: $(psql -U postgres -d railway -Atc 'SELECT count(*) FROM generations') generations"
