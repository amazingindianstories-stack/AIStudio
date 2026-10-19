#!/bin/sh
# Gate 2: full local rehearsal of one commit. No internet, no provider keys, no deploys.
#
#   REHEARSAL_DB=<pg container on network veevee-rehearsal holding a restored Green copy>
#   REHEARSAL_DB_HOST=<its IP on that network>  REHEARSAL_API_PASSWORD=...  REHEARSAL_WORKER_PASSWORD=...
#   REHEARSAL_OBSERVER_URL=<owner DSN of the local copy, read-only use>  REHEARSAL_USER=<email of a user in the copy>  REHEARSAL_PREFIX=<32-hex namespace used by the copy's RLS>
#   scripts/release/rehearse_local.sh [commit]
#
# Pending migrations are applied first as the copy's owner (REHEARSAL_OBSERVER_URL), exactly as a
# production rollout does. REHEARSAL_MANAGED_PORTRAITS=0 rehearses with the automatic portrait pool off.
# REHEARSAL_MAGNIFIC=0 rehearses with Magnific upscaling off (the gateway must then refuse it).
# REHEARSAL_KLING=0 rehearses with Kling images off (the paid guard must then refuse them at enqueue).
# API runs the real entrypoint (paid guard, export admission, portrait lifecycle, gateway); only its Gemini host
# (the admin chat agent) is answered by the fake provider network (scripts/release/rehearsal_api/sitecustomize.py).
# Workers run scripts/release/rehearsal_worker.py: the production code with the provider
# network replaced by testsupport.fake_providers before the paid guard is installed.
set -eu
COMMIT=$(git rev-parse --verify "${1:-HEAD}^{commit}"); SHORT=$(printf %.12s "$COMMIT")
ROOT=$(git rev-parse --show-toplevel)
: "${REHEARSAL_OBSERVER_URL:?}" "${REHEARSAL_DB:?}" "${REHEARSAL_DB_HOST:?}" "${REHEARSAL_API_PASSWORD:?}" "${REHEARSAL_WORKER_PASSWORD:?}" "${REHEARSAL_USER:?}" "${REHEARSAL_PREFIX:?}"
NET=veevee-rehearsal; IMAGE="veevee-backend:rehearse-$SHORT"; VOL="veevee-rehearsal-media-$SHORT"
BASE=$(mktemp -d "${TMPDIR:-/tmp}/veevee-rehearse-$SHORT.XXXX"); WORK="$BASE/src"
NAMES="vr-api vr-gen vr-export vr-sched"
cleanup() { for n in $NAMES; do docker rm -f "$n" >/dev/null 2>&1 || true; done; docker volume rm "$VOL" >/dev/null 2>&1 || true
  git -C "$ROOT" worktree remove --force "$WORK" >/dev/null 2>&1 || true; rm -rf "$BASE"; }
trap cleanup EXIT INT TERM
for n in $NAMES; do docker rm -f "$n" >/dev/null 2>&1 || true; done
git -C "$ROOT" worktree add --quiet --detach "$WORK" "$COMMIT"
docker build -q -f "$WORK/backend/Dockerfile" -t "$IMAGE" "$WORK" >/dev/null
docker network inspect "$NET" --format '{{.Internal}}' | grep -qx true || { echo "network $NET must be --internal"; exit 1; }
# Nothing else may work this database meanwhile (another worker would take the rehearsal's jobs).
if [ "$(docker ps -q --filter "name=veevee-local-generation" --filter status=running)" ]; then
  echo "stop the local stack's app services first (docker compose stop api generation export scheduler)"; exit 1; fi
# Earlier local rehearsals may have left unregistered queued rows in the copy; close them (local copy only).
docker exec "$REHEARSAL_DB" psql -U postgres -d railway -qAtc "UPDATE generations SET status='failed', error='closed before local rehearsal' WHERE status IN ('queued','running')" >/dev/null
docker volume create "$VOL" >/dev/null
MANAGED="-e VEEVEE_MANAGED_PORTRAITS=${REHEARSAL_MANAGED_PORTRAITS:-1} -e BYTEPLUS_ACCESS_KEY_ID=rehearsal-fake -e BYTEPLUS_SECRET_ACCESS_KEY=rehearsal-fake"
SECRET="rehearsal-ingress-$(openssl rand -hex 24)"
PAID='{"approved_scope":"GOAL4_EXISTING_GREEN_PREVIEW_UNLIMITED_NEW_IMAGE_AND_SEEDANCE_20_25_PAID_ONLY","unlimited_new_jobs":true,"maximum_total_cents":null}'
COMMON="-e DJANGO_SECRET_KEY=rehearsal-django-secret-$(openssl rand -hex 16) -e AUTH_SECRET=rehearsal-auth-secret-$(openssl rand -hex 16)
 -e DJANGO_ALLOWED_HOSTS=127.0.0.1 -e DJANGO_BROWSER_ORIGINS=https://veevee.ai -e PUBLIC_APP_URL=https://veevee.ai
 -e VEEVEE_MEDIA_BACKEND=filesystem -e VEEVEE_MEDIA_ROOT=/media -e MOCK_GENERATION=0 -e MOCK_ASSET_PROVIDER=0
 -e ARK_API_KEY=rehearsal-fake-key -e GOOGLE_API_KEY=rehearsal-fake-key -e AWS_EC2_METADATA_DISABLED=true -e PYTHONUNBUFFERED=1
 -e MAGNIFIC_API_KEY=rehearsal-fake-key -e VEEVEE_MAGNIFIC_UPSCALE=${REHEARSAL_MAGNIFIC:-1} -e VEEVEE_KLING=${REHEARSAL_KLING:-1}"
# shellcheck disable=SC2086
docker run --rm --network "$NET" $COMMON -e DATABASE_URL="$REHEARSAL_OBSERVER_URL" -w /app "$IMAGE" python manage.py migrate --noinput \
  > "$BASE/migrate.txt" 2>&1 || { cat "$BASE/migrate.txt"; echo "== migration failed"; exit 1; }
grep -E "Applying|No migrations" "$BASE/migrate.txt" || true
API_DB="postgresql://goal4_green_preview_api:$REHEARSAL_API_PASSWORD@$REHEARSAL_DB_HOST:5432/railway"
WORKER_DB="postgresql://goal4_green_preview_worker:$REHEARSAL_WORKER_PASSWORD@$REHEARSAL_DB_HOST:5432/railway"
NS="-e VEEVEE_LEASE_PREFIX=lease:g4preview:$REHEARSAL_PREFIX: -e VEEVEE_NAMING_PREFIX=g4preview:$REHEARSAL_PREFIX:"
# shellcheck disable=SC2086
docker run -d --name vr-api --network "$NET" -v "$VOL:/media" -v "$WORK/scripts:/scripts:ro" $COMMON $MANAGED -e DATABASE_URL="$API_DB" \
  -e VEEVEE_INGRESS_SECRET="$SECRET" -e PORT=18081 -e VEEVEE_EXPORT_ADMISSION=1 -e VEEVEE_PORTRAIT_LIFECYCLE=1 -e "VEEVEE_PAID_GUARD=$PAID" \
  -e VEEVEE_REHEARSAL=1 -e PYTHONPATH=/scripts/release/rehearsal_api "$IMAGE" python -m deploy.entrypoint api >/dev/null
# shellcheck disable=SC2086
docker run -d --name vr-gen --network "$NET" -v "$VOL:/media" -v "$WORK/scripts:/scripts:ro" $COMMON $MANAGED $NS -e DATABASE_URL="$WORKER_DB" \
  -e KLING_API=rehearsal-fake-key -e VEEVEE_REHEARSAL=1 -e "VEEVEE_PAID_GUARD=$PAID" "$IMAGE" python /scripts/release/rehearsal_worker.py generation >/dev/null
# shellcheck disable=SC2086
docker run -d --name vr-export --network "$NET" -v "$VOL:/media" -v "$WORK/scripts:/scripts:ro" $COMMON $NS -e DATABASE_URL="$WORKER_DB" \
  -e VEEVEE_REHEARSAL=1 -e VEEVEE_EXPORT_ADMISSION=1 "$IMAGE" python /scripts/release/rehearsal_worker.py export >/dev/null
# shellcheck disable=SC2086
docker run -d --name vr-sched --network "$NET" -v "$VOL:/media" -v "$WORK/scripts:/scripts:ro" $COMMON $MANAGED $NS -e DATABASE_URL="$WORKER_DB" \
  -e VEEVEE_REHEARSAL=1 -e "VEEVEE_PAID_GUARD=$PAID" "$IMAGE" python /scripts/release/rehearsal_worker.py scheduler >/dev/null
until docker exec vr-api python -c "import http.client as h;c=h.HTTPConnection('127.0.0.1',18081,timeout=3);c.request('GET','/__g4_readiness');exit(c.getresponse().status!=200)" 2>/dev/null; do sleep 1; done
STATUS=0
# shellcheck disable=SC2086
docker exec $COMMON $MANAGED -e DATABASE_URL="$API_DB" -e REHEARSAL_OBSERVER_URL="$REHEARSAL_OBSERVER_URL" -e PYTHONPATH=/app -w /app vr-api python /scripts/release/rehearsal_probe.py "$SECRET" "$REHEARSAL_USER" > "$BASE/probe.txt" 2>&1 || STATUS=$?
grep -v '^{"event": "request"' "$BASE/probe.txt" || true
for n in vr-gen vr-export vr-sched; do
  if [ "$(docker inspect -f '{{.State.Running}}' "$n")" != true ]; then echo "FAIL $n exited"; STATUS=1; fi
  docker logs "$n" 2>&1 | grep -E "Traceback|Error|rehearsal_worker_ready" | sed "s/^/  [$n] /" | head -5
done
[ "$STATUS" = 0 ] || { echo "== REHEARSAL FAILED for $SHORT"; exit 1; }
PASS_DIR="${VEEVEE_GATE_DIR:-$HOME/Library/Application Support/Veevee/release-gate}"; mkdir -p "$PASS_DIR"
grep -E '^(PASS|FAIL) ' "$BASE/probe.txt" | python3 -c 'import json,sys,datetime; print(json.dumps({"commit":sys.argv[1],"passed_at":datetime.datetime.utcnow().isoformat()+"Z","checks":[l.strip() for l in sys.stdin]}))' "$COMMIT" > "$PASS_DIR/$COMMIT.rehearsal.json"
echo "== REHEARSAL PASSED for $SHORT"
