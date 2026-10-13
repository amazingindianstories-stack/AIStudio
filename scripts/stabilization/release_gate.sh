#!/bin/sh
# Release gate for one exact commit. Nothing is deployed and no provider is contacted.
#
#   scripts/stabilization/release_gate.sh [commit]
#
# Builds the backend image from a clean `git archive` of the commit, runs the full
# Django suite inside that image against a throwaway PostgreSQL 18 (including the
# fake-provider worker simulations), scans for undefined names, checks migrations,
# and runs the frontend tests, lint and production build. On success it writes a
# pass record that stage_railway_deploy.py requires.
set -eu
COMMIT=$(git rev-parse --verify "${1:-HEAD}^{commit}")
SHORT=$(printf %.12s "$COMMIT")
ROOT=$(git rev-parse --show-toplevel)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/veevee-gate-$SHORT.XXXX")
NET="veevee-gate-$SHORT"; DB="veevee-gate-db-$SHORT"; IMAGE="veevee-backend:gate-$SHORT"
PASS_DIR="${VEEVEE_GATE_DIR:-$HOME/Library/Application Support/Veevee/release-gate}"
cleanup() { docker rm -f "$DB" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT INT TERM
step() { printf '\n== %s\n' "$1"; }

step "Clean source of $SHORT"
git -C "$ROOT" archive "$COMMIT" | tar -x -C "$WORK"

step "Build backend image"
docker build -q -f "$WORK/backend/Dockerfile" -t "$IMAGE" "$WORK" >/dev/null

step "Undefined-name scan (pyflakes)"
docker run --rm "$IMAGE" sh -c 'pip install -q pyflakes==3.2.0 >/dev/null 2>&1; python -m pyflakes apps config deploy testsupport 2>&1 | grep -v "/migrations/" | grep "undefined name " && exit 1 || exit 0'

step "Backend suite inside the image (throwaway PostgreSQL 18)"
docker network create "$NET" >/dev/null
docker run -d --name "$DB" --network "$NET" -e POSTGRES_PASSWORD=gate -e POSTGRES_DB=veevee_django_migration postgres:18.6 >/dev/null
until docker exec "$DB" pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
GATE_ENV="-e MIGRATION_TEST_ISOLATED=1 -e DJANGO_SETTINGS_MODULE=config.settings.test -e DATABASE_URL=postgresql://postgres:gate@127.0.0.1:5432/veevee_django_migration -e DJANGO_SECRET_KEY=gate-secret-key-000000000000000000000000000000 -e AUTH_SECRET=gate-auth-secret-0000000000000000000000000000000"
# shellcheck disable=SC2086
docker run --rm --network "container:$DB" $GATE_ENV -v "$WORK/scripts:/scripts:ro" "$IMAGE" python manage.py test --noinput --parallel 1 2>&1 | grep -v '^{"event"' | tail -5 | tee "$WORK/backend.txt"
grep -q '^OK' "$WORK/backend.txt"

step "Migrations: no model changes"
# shellcheck disable=SC2086
docker run --rm --network "container:$DB" $GATE_ENV "$IMAGE" python manage.py makemigrations --check --dry-run

step "Frontend tests, lint and production build"
cp -c -R "$ROOT/node_modules" "$WORK/node_modules" 2>/dev/null || cp -R "$ROOT/node_modules" "$WORK/node_modules"
(cd "$WORK" && npm test 2>&1 | grep -E '^# (pass|fail)' | tee "$WORK/frontend.txt" && grep -q '^# fail 0' "$WORK/frontend.txt" \
  && npx eslint src --max-warnings=0 && NEXT_TELEMETRY_DISABLED=1 npx next build >/dev/null)

mkdir -p "$PASS_DIR"
printf '{"commit":"%s","passed_at":"%s","backend":"%s","frontend":"%s"}\n' "$COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$(tr '\n' ' ' < "$WORK/backend.txt" | sed 's/"//g')" "$(tr '\n' ' ' < "$WORK/frontend.txt")" > "$PASS_DIR/$COMMIT.json"
step "RELEASE GATE PASSED for $SHORT"
