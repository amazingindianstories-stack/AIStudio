#!/bin/sh
# Local Veevee: every backend service in Docker + the Next.js frontend on the host.
#
#   local/veevee.sh up         build image, start db (restores the Green copy on first run),
#                              fake providers, API, generation/export workers, scheduler
#   local/veevee.sh frontend   run the Next.js app on http://localhost:3000 against the local API
#   local/veevee.sh user       create/refresh the local admin login (prints email + password)
#   local/veevee.sh status     service state, fake provider pool, queue
#   local/veevee.sh logs [svc] follow logs
#   local/veevee.sh restart [svc]   pick up backend code changes
#   local/veevee.sh down       stop (data kept)        local/veevee.sh reset   stop and delete local data
#
# Providers are fake by default (no keys, no cost). Nothing here touches production.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/.." && pwd)
ENV="$HERE/.env"
dc() { docker compose -f "$HERE/compose.yaml" --env-file "$ENV" "$@"; }
rand() { openssl rand -hex "$1"; }
ensure_env() {
  [ -f "$ENV" ] && return
  umask 077
  cat > "$ENV" <<EOF
# Local-only secrets (generated). Never commit.
DJANGO_SECRET_KEY=local-$(rand 24)
AUTH_SECRET=local-$(rand 24)
VEEVEE_INGRESS_SECRET=local-ingress-$(rand 24)
POSTGRES_PASSWORD=$(rand 16)
API_DB_PASSWORD=$(rand 16)
WORKER_DB_PASSWORD=$(rand 16)
DEPTH_WORKER_TOKEN=local-depth-$(rand 24)
LOCAL_ADMIN_EMAIL=local-admin@veevee.test
LOCAL_ADMIN_PASSWORD=$(rand 12)
VEEVEE_LOCAL_PROVIDERS=fake
VEEVEE_NAMESPACE=7d36fc0b620f4f7297e992e9d1fe9283
VEEVEE_SEED_DIR=$HOME/Library/Application Support/Veevee/goal4-private/stabilization-2026-10-13/backups
VEEVEE_PAID_GUARD={"approved_scope":"GOAL4_EXISTING_GREEN_PREVIEW_UNLIMITED_NEW_IMAGE_AND_SEEDANCE_20_25_PAID_ONLY","unlimited_new_jobs":true,"maximum_total_cents":null}
EOF
  echo "created $ENV (local-only secrets)"
}
val() { grep -E "^$1=" "$ENV" | head -1 | cut -d= -f2-; }

cmd=${1:-status}; shift || true
case "$cmd" in
  up)
    ensure_env
    docker build -q -f "$ROOT/backend/Dockerfile" -t veevee-backend:local "$ROOT" >/dev/null
    dc up -d
    echo "waiting for the API (first run restores the Green copy; this can take a few minutes)…"
    until curl -fsS http://127.0.0.1:18081/__g4_readiness >/dev/null 2>&1; do sleep 3; done
    echo "API ready on http://127.0.0.1:18081 (gateway). Next: local/veevee.sh user, then local/veevee.sh frontend"
    ;;
  user)
    ensure_env
    dc exec -T -e LOCAL_ADMIN_EMAIL="$(val LOCAL_ADMIN_EMAIL)" -e LOCAL_ADMIN_PASSWORD="$(val LOCAL_ADMIN_PASSWORD)" api \
      sh -c 'cd /app && python - <<PY
import os, time, uuid, django
django.setup()
from apps.authentication.models import User
from apps.authentication.password import hash_password
email = os.environ["LOCAL_ADMIN_EMAIL"]
hashed = hash_password(os.environ["LOCAL_ADMIN_PASSWORD"])
values = {"password_hash": hashed["hash"], "password_salt": hashed["salt"]}
user = User.objects.filter(email=email).first()
if user is None:
    user = User.objects.create(id=uuid.uuid4(), email=email, name="Local Admin", role="admin", created_at=int(time.time()*1000), **values)
else:
    for k, v in values.items(): setattr(user, k, v)
    user.role = "admin"; user.is_active = True; user.auth_version = (user.auth_version or 0) + 1; user.save()
print("ok")
PY'
    echo "login: $(val LOCAL_ADMIN_EMAIL)  password: $(val LOCAL_ADMIN_PASSWORD)  (local only)"
    ;;
  frontend)
    ensure_env
    cd "$ROOT"
    DJANGO_API_ORIGIN=http://127.0.0.1:18081 DJANGO_API_ALLOW_LOCAL=1 GOAL4_PRIVATE_INGRESS_SECRET="$(val VEEVEE_INGRESS_SECRET)" \
      NEXT_TELEMETRY_DISABLED=1 exec npx next dev -p 3000
    ;;
  status)
    dc ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'
    curl -fsS http://127.0.0.1:18099/state 2>/dev/null | python3 -c 'import json,sys; s=json.load(sys.stdin); print("fake providers: capacity", s["asset_capacity"], "| live assets", s["live_assets"], "| seedance tasks", s["seedance_tasks"])' || true
    ;;
  logs) dc logs -f --tail 100 "$@" ;;
  restart) dc restart "$@" ;;
  down) dc down ;;
  reset) dc down -v ;;
  *) sed -n 2,14p "$0"; exit 1 ;;
esac
