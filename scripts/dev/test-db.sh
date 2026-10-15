#!/bin/sh
# Run one command against a throwaway PostgreSQL 18.6 with an allowlisted environment.
#
#   scripts/dev/test-db.sh PYTHON ARGS...
#
# PYTHON is an interpreter with backend/requirements.txt installed. Examples:
#   scripts/dev/test-db.sh ~/venvs/veevee/bin/python backend/manage.py test apps.generation
#   scripts/dev/test-db.sh ~/venvs/veevee/bin/python scripts/dev/browser-harness.py --install-browser
#
# The database is a disposable container bound to 127.0.0.1 and removed on exit. The command
# runs under `env -i`, so no inherited credentials or DATABASE_URL reach it, and Django never
# loads dotenv files. Mock providers only; nothing leaves this machine.
set -eu
[ $# -ge 2 ] || { sed -n '2,12p' "$0"; exit 2; }
PYTHON=$1; shift
ROOT=$(git rev-parse --show-toplevel)
NAME="veevee-test-db-$$"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/veevee-test.XXXX")
cleanup() {
  status=$?
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  if [ "$status" = 0 ]; then rm -rf "$WORK"; else echo "kept logs and temporary files in $WORK"; fi
}
trap cleanup EXIT INT TERM

docker run -d --name "$NAME" -p 127.0.0.1::5432 --tmpfs /var/lib/postgresql:rw \
  -e POSTGRES_PASSWORD=disposable -e POSTGRES_DB=veevee_django_migration postgres:18.6 >/dev/null
# TCP only opens once the entrypoint's initialisation server has been replaced.
until docker exec "$NAME" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; do sleep 1; done
PORT=$(docker port "$NAME" 5432/tcp | head -1 | sed 's/.*://')

# Node runs the browser suite; ffmpeg makes native MOV fixtures; libvips backs image handling
# (pyvips loads it from the lib directory next to the `vips` command, e.g. ~/.nix-profile/lib).
TOOLS=""; LIBS=""
for tool in node ffmpeg vips; do
  if location=$(command -v "$tool"); then TOOLS="$TOOLS$(dirname "$location"):"; else echo "note: $tool not on PATH"; fi
done
if location=$(command -v vips); then LIBS=$(cd "$(dirname "$location")/../lib" && pwd); fi
case "$(uname)" in Darwin) BROWSERS="$HOME/Library/Caches/ms-playwright" ;; *) BROWSERS="$HOME/.cache/ms-playwright" ;; esac

cd "$ROOT"
env -i PATH="${TOOLS}/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" HOME="$WORK" TMPDIR="$WORK" \
  LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 CI=1 NEXT_TELEMETRY_DISABLED=1 AWS_EC2_METADATA_DISABLED=true \
  PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$BROWSERS}" \
  DYLD_FALLBACK_LIBRARY_PATH="$LIBS" LD_LIBRARY_PATH="$LIBS" \
  DATABASE_URL="postgresql://postgres:disposable@127.0.0.1:$PORT/veevee_django_migration" \
  DJANGO_SETTINGS_MODULE=config.settings.test MIGRATION_TEST_ISOLATED=1 \
  DJANGO_SECRET_KEY=disposable-django-secret-key-00000000000000000000 \
  AUTH_SECRET=disposable-auth-secret-0000000000000000000000000000 \
  DJANGO_ALLOWED_HOSTS=127.0.0.1,localhost,testserver MOCK_GENERATION=1 MOCK_ASSET_PROVIDER=1 \
  "$PYTHON" "$@"
