#!/bin/sh
set -eu

if [ -n "${GCP_SERVICE_ACCOUNT_JSON:-}" ]; then
  umask 077
  credential_path=/tmp/lumina-gcp-service-account.json
  printf '%s' "$GCP_SERVICE_ACCOUNT_JSON" > "$credential_path"
  export GOOGLE_APPLICATION_CREDENTIALS="$credential_path"
fi

case "${1:-}" in
  api)
    python manage.py schema_preflight --require-adopted
    python manage.py migrate --noinput
    python manage.py collectstatic --noinput
    exec gunicorn config.wsgi --bind "0.0.0.0:${PORT}" --workers "${WEB_CONCURRENCY:-3}"
    ;;
  login-cleanup)
    exec python manage.py cleanup_login_attempts
    ;;
  video-reconciliation)
    exec python manage.py reconcile_videos
    ;;
  *)
    echo "usage: $0 api|login-cleanup|video-reconciliation" >&2
    exit 64
    ;;
esac
